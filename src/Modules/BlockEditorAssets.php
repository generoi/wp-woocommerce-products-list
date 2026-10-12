<?php

namespace GeneroWP\ProductsList\Modules;

use GeneroWP\ProductsList\Module;

/**
 * The block editor for the description modal, loaded only when the modal
 * opens. The scripts and styles it needs (block editor, core blocks,
 * formats, TinyMCE for the Classic block, the media library) are printed
 * into an inert <template> at the end of the page; the app copies them
 * into the document the first time the modal opens
 * (resources/edit/description-modal/load-block-editor.ts). Handles the
 * page already printed are skipped, so nothing loads twice.
 */
class BlockEditorAssets implements Module
{
    public const TEMPLATE_ID = 'wc-products-list-block-editor-assets';

    /** Scripts the modal needs; their dependencies come along. */
    private const SCRIPTS = ['wp-block-library', 'wp-format-library', 'wp-block-editor', 'wp-media-utils', 'editor', 'media-editor', 'media-audiovideo'];

    private const STYLES = ['wp-block-editor', 'wp-block-library', 'wp-format-library', 'wp-edit-blocks', 'editor-buttons', 'media-views', 'imgareaselect'];

    /** The script handles wp_enqueue_media() adds, kept out of the page's own queue. */
    private const MEDIA_SCRIPTS = ['media-editor', 'media-audiovideo', 'mce-view', 'image-edit', 'media-upload', 'thickbox'];

    private const MEDIA_STYLES = ['media-views', 'imgareaselect', 'thickbox'];

    public function register(): void
    {
        // wp_enqueue_media() before admin_footer prints the media templates (inert HTML); its scripts are taken out of the queue again.
        add_action('admin_footer', [$this, 'prepareMedia'], 1);
        add_action('admin_print_footer_scripts', [$this, 'printTemplate'], 100);
    }

    public function prepareMedia(): void
    {
        if (! AdminPage::isScreen()) {
            return;
        }

        wp_enqueue_media();

        foreach (self::MEDIA_SCRIPTS as $handle) {
            wp_dequeue_script($handle);
        }
        foreach (self::MEDIA_STYLES as $handle) {
            wp_dequeue_style($handle);
        }
    }

    public function printTemplate(): void
    {
        if (! AdminPage::isScreen()) {
            return;
        }

        if (! class_exists('_WP_Editors', false)) {
            require_once ABSPATH.'wp-includes/class-wp-editor.php';
        }

        ob_start();
        wp_styles()->do_items(self::STYLES);
        wp_scripts()->do_items(self::SCRIPTS);
        // The Classic block runs TinyMCE through wp.oldEditor, as the block editor screen sets it up.
        \_WP_Editors::print_default_editor_scripts();
        echo "<script>window.wp.oldEditor = window.wp.editor;</script>\n";
        $html = (string) ob_get_clean();

        echo '<template id="'.esc_attr(self::TEMPLATE_ID).'">'.$html.'</template>'."\n";
    }
}
