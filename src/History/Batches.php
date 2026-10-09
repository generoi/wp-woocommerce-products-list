<?php

namespace GeneroWP\ProductsList\History;

use GeneroWP\ProductsList\ListMode;
use GeneroWP\ProductsList\Rest\Concurrency;
use WP_REST_Request;

/**
 * SPIKE: batches as terms of a private taxonomy on `revision`.
 *
 * One term per user gesture: the app's batch id (`X-WC-Products-List-Batch`)
 * when the request carries one, otherwise one per REST request, or one
 * per PHP process for the admin, imports and WP-CLI. Term meta holds the
 * source, the user, the time, the batch it reverts and the changed
 * fields. Every revision taken in the batch gets the term; the
 * relationship rows go in with one INSERT each and the term count and
 * field list are written once per request.
 */
final class Batches
{
    public const TAXONOMY = 'wcpl_batch';

    /** @var array{uuid: string, source: string, reverts: string}|null forced by Restore and tests */
    private static ?array $forced = null;

    /** @var array<int, array{uuid: string, source: string, reverts: string}> */
    private static array $forcedStack = [];

    /** One uuid per outermost REST request without the app's header. */
    private static ?string $restUuid = null;

    private static int $restDepth = 0;

    /** One uuid per process outside REST. */
    private static ?string $processUuid = null;

    private static bool $importing = false;

    /** @var array<string, array{term_id: int, tt_id: int}> */
    private static array $terms = [];

    /** @var array<string, array<string, true>> uuid => fields added since the last flush */
    private static array $fields = [];

    private static ?string $lastUuid = null;

    /** @var array<string, int> uuid => revisions assigned since the last flush */
    private static array $assigned = [];

    public static function register(): void
    {
        did_action('init') ? self::registerTaxonomy() : add_action('init', [self::class, 'registerTaxonomy'], 5);

        self::hooks(true);
    }

    public static function registerTaxonomy(): void
    {
        if (taxonomy_exists(self::TAXONOMY)) {
            return;
        }

        register_taxonomy(self::TAXONOMY, 'revision', [
            'public' => false,
            'show_ui' => false,
            'show_in_rest' => false,
            'rewrite' => false,
            'query_var' => false,
            'hierarchical' => false,
            'update_count_callback' => [self::class, 'updateCount'],
        ]);
    }

    /** @var array<int, true> term_taxonomy ids whose count is recounted at the next flush */
    private static array $pendingCounts = [];

    private static bool $deferCount = false;

    /**
     * The taxonomy's `update_count_callback`: core's generic count, except
     * while `assign()` adds a revision. Core recounts the term after every
     * `wp_set_object_terms()` (a COUNT(*) over all the batch's
     * relationships), so a 24,000-revision campaign got about 10 ms slower
     * per save by its end; the term is recounted once per request in
     * `flush()` instead.
     *
     * @param  array<int, int|string>  $terms  term_taxonomy ids
     * @param  \WP_Taxonomy|string  $taxonomy
     */
    public static function updateCount($terms, $taxonomy): void
    {
        if (self::$deferCount) {
            foreach ((array) $terms as $ttId) {
                self::$pendingCounts[(int) $ttId] = true;
            }

            return;
        }

        _update_generic_term_count($terms, $taxonomy instanceof \WP_Taxonomy ? $taxonomy : get_taxonomy((string) $taxonomy));
    }

    /** Whether a batch was set explicitly (Restore, tests). */
    public static function forced(): bool
    {
        return self::$forced !== null;
    }

    /** Whether a WooCommerce CSV import is running in this process. */
    public static function importingNow(): bool
    {
        return self::$importing;
    }

    /**
     * Revisions recorded under a batch, including those retention has
     * pruned since (term meta `revisions`, kept per flush).
     */
    public static function recorded(string $uuid): int
    {
        $term = self::term($uuid);

        return $term === null ? 0 : (int) get_term_meta($term['term_id'], 'revisions', true);
    }

    /**
     * Delete batch terms whose revisions are all gone (pruned by
     * retention or deleted), with their term meta. Terms younger than an
     * hour are left alone: a batch being written may not have its first
     * revision yet. Daily, with the log prune.
     */
    public static function pruneEmpty(int $limit = 1000): int
    {
        global $wpdb;

        self::registerTaxonomy();

        $ids = $wpdb->get_col($wpdb->prepare(
            "SELECT tt.term_id FROM {$wpdb->term_taxonomy} tt LEFT JOIN {$wpdb->termmeta} tm ON tm.term_id = tt.term_id AND tm.meta_key = 'time'
             WHERE tt.taxonomy = %s AND tt.count = 0 AND (tm.meta_value IS NULL OR CAST(tm.meta_value AS UNSIGNED) < %d) LIMIT %d",
            self::TAXONOMY,
            time() - HOUR_IN_SECONDS,
            $limit
        ));
        $deleted = 0;

        foreach (is_array($ids) ? $ids : [] as $id) {
            if (wp_delete_term((int) $id, self::TAXONOMY) === true) {
                $deleted++;
            }
        }

        self::$terms = [];

        return $deleted;
    }

    public static function hooks(bool $on): void
    {
        $add = $on ? 'add_filter' : 'remove_filter';
        $add('rest_request_before_callbacks', [self::class, 'beginRequest'], 5, 3);
        $add('rest_request_after_callbacks', [self::class, 'endRequest'], 1001, 3);
        $add('shutdown', [self::class, 'flush'], 0);
        $add('woocommerce_product_import_pre_insert_product_object', [self::class, 'importing'], 10, 1);
    }

    /**
     * @param  mixed  $object
     * @return mixed
     */
    public static function importing($object)
    {
        self::$importing = true;

        return $object;
    }

    /**
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function beginRequest($response, $handler, WP_REST_Request $request)
    {
        if (self::$restDepth === 0) {
            self::$restUuid = null;
        }

        self::$restDepth++;

        return $response;
    }

    /**
     * @param  mixed  $response
     * @param  mixed  $handler
     * @return mixed
     */
    public static function endRequest($response, $handler, WP_REST_Request $request)
    {
        self::$restDepth = max(0, self::$restDepth - 1);

        if (self::$restDepth === 0) {
            self::flush();
            self::$restUuid = null;
        }

        return $response;
    }

    /**
     * Run what follows under a given batch (Restore, tests).
     */
    public static function begin(string $uuid, string $source, string $reverts = ''): void
    {
        if (self::$forced !== null) {
            self::$forcedStack[] = self::$forced;
        }

        self::$forced = ['uuid' => $uuid, 'source' => $source, 'reverts' => $reverts];
    }

    public static function end(): void
    {
        self::flush();
        self::$forced = self::$forcedStack === [] ? null : array_pop(self::$forcedStack);
    }

    /** For tests: start over, as a new process would. */
    public static function reset(): void
    {
        self::$forced = null;
        self::$forcedStack = [];
        self::$restUuid = null;
        self::$restDepth = 0;
        self::$processUuid = null;
        self::$importing = false;
        self::$terms = [];
        self::$fields = [];
        self::$assigned = [];
        self::$pendingCounts = [];
        self::$lastUuid = null;
    }

    /**
     * @return array{uuid: string, source: string, reverts: string}
     */
    public static function context(): array
    {
        if (self::$forced !== null) {
            return self::$forced;
        }

        if (self::$restDepth > 0) {
            $header = ListMode::batchId();

            if ($header !== null) {
                $source = ListMode::source();

                return ['uuid' => $header, 'source' => $source, 'reverts' => ''];
            }

            self::$restUuid ??= wp_generate_uuid4();

            return ['uuid' => self::$restUuid, 'source' => 'rest', 'reverts' => ''];
        }

        self::$processUuid ??= wp_generate_uuid4();

        $source = match (true) {
            self::$importing => 'import',
            defined('WP_CLI') && WP_CLI => 'cli',
            is_admin() => 'admin',
            default => 'php',
        };

        return ['uuid' => self::$processUuid, 'source' => $source, 'reverts' => ''];
    }

    /** The batch the last revision went into. */
    public static function lastUuid(): ?string
    {
        return self::$lastUuid;
    }

    /**
     * @return array{term_id: int, tt_id: int}|null
     */
    public static function term(string $uuid): ?array
    {
        if (isset(self::$terms[$uuid])) {
            return self::$terms[$uuid];
        }

        $term = get_term_by('slug', $uuid, self::TAXONOMY);

        if (! $term instanceof \WP_Term) {
            return null;
        }

        return self::$terms[$uuid] = ['term_id' => (int) $term->term_id, 'tt_id' => (int) $term->term_taxonomy_id];
    }

    /**
     * The term of a batch read from the database, past every cache: the
     * requests of one batch run at the same time (three by default), and
     * another one may have created it since this process looked.
     *
     * @return array{term_id: int, tt_id: int}|null
     */
    private static function stored(string $uuid): ?array
    {
        global $wpdb;

        $row = $wpdb->get_row($wpdb->prepare(
            "SELECT t.term_id, tt.term_taxonomy_id FROM {$wpdb->terms} t JOIN {$wpdb->term_taxonomy} tt ON tt.term_id = t.term_id WHERE tt.taxonomy = %s AND t.slug = %s ORDER BY t.term_id ASC LIMIT 1",
            self::TAXONOMY,
            $uuid
        ));

        if (! is_object($row)) {
            return null;
        }

        return self::$terms[$uuid] = ['term_id' => (int) $row->term_id, 'tt_id' => (int) $row->term_taxonomy_id];
    }

    /**
     * The named lock of one batch: its term is created, and its counters
     * written, by one request at a time.
     */
    private static function lock(string $uuid): ?string
    {
        $name = Concurrency::lockName('b', md5($uuid));

        // Best effort: when the lock cannot be had the work goes on; the
        // insert below then falls back to the term the other request made.
        return Concurrency::acquire($name, 5) ? $name : null;
    }

    private static function unlock(?string $name): void
    {
        if ($name !== null) {
            Concurrency::release($name);
        }
    }

    /**
     * The batch's term, created on its first revision. Under the batch's
     * lock and from the database: two requests of a batch arriving at
     * once would otherwise both insert it, core would delete one of the
     * two as a duplicate slug and the loser's revisions would go into no
     * batch (an undo would then leave those rows as they are).
     *
     * @param  array{uuid: string, source: string, reverts: string}  $context
     * @return array{term_id: int, tt_id: int}|null
     */
    private static function ensure(array $context): ?array
    {
        $uuid = $context['uuid'];

        if (isset(self::$terms[$uuid])) {
            return self::$terms[$uuid];
        }

        $lock = self::lock($uuid);

        try {
            $existing = self::stored($uuid);

            if ($existing !== null) {
                return $existing;
            }

            $inserted = wp_insert_term($uuid, self::TAXONOMY, ['slug' => $uuid]);

            if (is_wp_error($inserted)) {
                // Inserted by another request after all (no lock to be had).
                return self::stored($uuid);
            }

            $termId = (int) $inserted['term_id'];
            add_term_meta($termId, 'source', $context['source'], true);
            add_term_meta($termId, 'user', get_current_user_id(), true);
            add_term_meta($termId, 'time', time(), true);

            if ($context['reverts'] !== '') {
                add_term_meta($termId, 'reverts', $context['reverts'], true);
            }

            return self::$terms[$uuid] = ['term_id' => $termId, 'tt_id' => (int) $inserted['term_taxonomy_id']];
        } finally {
            self::unlock($lock);
        }
    }

    public static function assign(int $revisionId): void
    {
        $context = self::context();
        $term = self::ensure($context);

        if ($term === null) {
            return;
        }

        // Core's API, count and caches included (docs/revisions.md: a direct
        // INSERT with one count update per request is the lighter option).
        self::$deferCount = true;

        try {
            wp_set_object_terms($revisionId, [$term['term_id']], self::TAXONOMY, true);
        } finally {
            self::$deferCount = false;
        }

        self::$lastUuid = $context['uuid'];
        self::$assigned[$context['uuid']] = (self::$assigned[$context['uuid']] ?? 0) + 1;
    }

    /**
     * @param  array<int, string>  $fields
     */
    public static function addFields(array $fields): void
    {
        $uuid = self::$lastUuid;

        if ($uuid === null) {
            return;
        }

        foreach ($fields as $field) {
            self::$fields[$uuid][$field] = true;
        }
    }

    /**
     * Write the field lists gathered since the last flush (once per request).
     */
    public static function flush(): void
    {
        if (self::$pendingCounts !== []) {
            $ttIds = array_keys(self::$pendingCounts);
            self::$pendingCounts = [];
            wp_update_term_count_now($ttIds, self::TAXONOMY);
        }

        $uuids = array_unique(array_merge(array_map('strval', array_keys(self::$assigned)), array_map('strval', array_keys(self::$fields))));

        foreach ($uuids as $uuid) {
            $term = self::term($uuid);

            if ($term === null) {
                continue;
            }

            // Read, add and write under the batch's lock, from the
            // database: the other requests of the batch flush too.
            $lock = self::lock($uuid);

            try {
                wp_cache_delete($term['term_id'], 'term_meta');

                if (isset(self::$assigned[$uuid])) {
                    self::writeMeta($term['term_id'], 'revisions', (string) (self::storedInt($term['term_id'], 'revisions') + self::$assigned[$uuid]));
                }

                if (isset(self::$fields[$uuid])) {
                    $existing = json_decode((string) get_term_meta($term['term_id'], 'fields', true), true);
                    $merged = array_values(array_unique(array_merge(is_array($existing) ? $existing : [], array_keys(self::$fields[$uuid]))));
                    sort($merged);
                    self::writeMeta($term['term_id'], 'fields', (string) wp_json_encode($merged));
                }
            } finally {
                self::unlock($lock);
            }
        }

        self::$assigned = [];
        self::$fields = [];
    }

    /**
     * A numeric term meta value as stored: the largest when an earlier
     * version wrote it twice.
     */
    private static function storedInt(int $termId, string $key): int
    {
        $values = get_term_meta($termId, $key);

        return is_array($values) && $values !== [] ? max(array_map('intval', $values)) : 0;
    }

    /**
     * Write one term meta value, leaving a single row: the read-modify-write
     * of an earlier version could add a key twice.
     */
    private static function writeMeta(int $termId, string $key, string $value): void
    {
        $values = get_term_meta($termId, $key);

        if (is_array($values) && count($values) > 1) {
            delete_term_meta($termId, $key);
            add_term_meta($termId, $key, $value, true);

            return;
        }

        update_term_meta($termId, $key, $value);
    }

    /**
     * The revisions of a batch with their parents, ordered by parent then id.
     *
     * @return array<int, array{id: int, parent: int}>
     */
    public static function revisions(string $uuid): array
    {
        global $wpdb;

        $term = self::term($uuid);

        if ($term === null) {
            return [];
        }

        $rows = $wpdb->get_results($wpdb->prepare(
            "SELECT p.ID, p.post_parent FROM {$wpdb->term_relationships} tr JOIN {$wpdb->posts} p ON p.ID = tr.object_id WHERE tr.term_taxonomy_id = %d ORDER BY p.post_parent, p.ID",
            $term['tt_id']
        ));

        return array_map(static fn ($row): array => ['id' => (int) $row->ID, 'parent' => (int) $row->post_parent], (array) $rows);
    }

    /**
     * Term meta of a batch.
     *
     * @return array{source: string, user: int, time: int, reverts: string, fields: array<int, string>}|null
     */
    public static function meta(string $uuid): ?array
    {
        $term = self::term($uuid);

        if ($term === null) {
            return null;
        }

        $fields = json_decode((string) get_term_meta($term['term_id'], 'fields', true), true);

        return [
            'source' => (string) get_term_meta($term['term_id'], 'source', true),
            'user' => (int) get_term_meta($term['term_id'], 'user', true),
            'time' => (int) get_term_meta($term['term_id'], 'time', true),
            'reverts' => (string) get_term_meta($term['term_id'], 'reverts', true),
            'fields' => is_array($fields) ? $fields : [],
        ];
    }
}
