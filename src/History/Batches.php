<?php

namespace GeneroWP\ProductsList\History;

use GeneroWP\ProductsList\ListMode;
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

    public static function register(): void
    {
        $register = static function (): void {
            register_taxonomy(self::TAXONOMY, 'revision', [
                'public' => false,
                'show_ui' => false,
                'show_in_rest' => false,
                'rewrite' => false,
                'query_var' => false,
                'hierarchical' => false,
                'update_count_callback' => '_update_generic_term_count',
            ]);
        };

        did_action('init') ? $register() : add_action('init', $register, 5);

        self::hooks(true);
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
     * @param  array{uuid: string, source: string, reverts: string}  $context
     * @return array{term_id: int, tt_id: int}|null
     */
    private static function ensure(array $context): ?array
    {
        $existing = self::term($context['uuid']);

        if ($existing !== null) {
            return $existing;
        }

        $inserted = wp_insert_term($context['uuid'], self::TAXONOMY, ['slug' => $context['uuid']]);

        if (is_wp_error($inserted)) {
            return null;
        }

        $termId = (int) $inserted['term_id'];
        add_term_meta($termId, 'source', $context['source'], true);
        add_term_meta($termId, 'user', get_current_user_id(), true);
        add_term_meta($termId, 'time', time(), true);

        if ($context['reverts'] !== '') {
            add_term_meta($termId, 'reverts', $context['reverts'], true);
        }

        return self::$terms[$context['uuid']] = ['term_id' => $termId, 'tt_id' => (int) $inserted['term_taxonomy_id']];
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
        wp_set_object_terms($revisionId, [$term['term_id']], self::TAXONOMY, true);
        self::$lastUuid = $context['uuid'];
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

        foreach (self::$fields as $uuid => $fields) {
            $term = self::term($uuid);

            if ($term === null) {
                continue;
            }

            $existing = json_decode((string) get_term_meta($term['term_id'], 'fields', true), true);
            $merged = array_values(array_unique(array_merge(is_array($existing) ? $existing : [], array_keys($fields))));
            sort($merged);
            update_term_meta($term['term_id'], 'fields', (string) wp_json_encode($merged));
        }

        self::$fields = [];
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
