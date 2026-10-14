import { describe, expect, it } from 'vitest';
import { contentOf, isBlockMarkup, isEmptyHtml, plainFigures, withoutBlockMarkup } from '../../resources/edit/description-modal/description-modal';

describe( 'withoutBlockMarkup', () => {
	it( 'drops block comments and the class names the editor adds to plain elements', () => {
		const serialized = [
			'<!-- wp:heading -->\n<h2 class="wp-block-heading">Material</h2>\n<!-- /wp:heading -->',
			'<!-- wp:list -->\n<ul class="wp-block-list"><!-- wp:list-item -->\n<li><strong>Upper</strong> leather</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->',
			'<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->',
			'<!-- wp:paragraph -->\n<p>Text</p>\n<!-- /wp:paragraph -->',
		].join( '\n\n' );

		expect( withoutBlockMarkup( serialized ) ).toBe( '<h2>Material</h2>\n<ul><li><strong>Upper</strong> leather</li>\n</ul>\n<hr>\n<p>Text</p>' );
	} );

	it( 'keeps class names that style an element', () => {
		expect( withoutBlockMarkup( '<!-- wp:image {"id":5,"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="a.jpg" alt="" class="wp-image-5"/></figure>\n<!-- /wp:image -->' ) ).toBe(
			'<figure class="wp-block-image size-large"><img src="a.jpg" alt="" class="wp-image-5"/></figure>'
		);
	} );
} );

describe( 'isBlockMarkup', () => {
	it( 'tells block markup from HTML', () => {
		expect( isBlockMarkup( '<!-- wp:paragraph --><p>a</p><!-- /wp:paragraph -->' ) ).toBe( true );
		expect( isBlockMarkup( '<p>a</p><!-- a comment -->' ) ).toBe( false );
	} );
} );

describe( 'isEmptyHtml', () => {
	it( 'counts empty paragraphs as nothing, but not media', () => {
		expect( isEmptyHtml( '' ) ).toBe( true );
		expect( isEmptyHtml( '<!-- wp:paragraph -->\n<p></p>\n<!-- /wp:paragraph -->' ) ).toBe( true );
		expect( isEmptyHtml( '<p>&nbsp;</p>' ) ).toBe( true );
		expect( isEmptyHtml( '<p>a</p>' ) ).toBe( false );
		expect( isEmptyHtml( '<figure><img src="a.jpg" alt=""/></figure>' ) ).toBe( false );
		expect( isEmptyHtml( '<hr>' ) ).toBe( false );
	} );
} );

describe( 'plainFigures', () => {
	it( 'takes a table out of its figure and turns an embed into its URL in a paragraph', () => {
		expect( plainFigures( '<figure class="wp-block-table"><table class="has-fixed-layout"><tbody><tr><td>a</td></tr></tbody></table></figure>' ) ).toBe(
			'<table><tbody><tr><td>a</td></tr></tbody></table>'
		);
		expect(
			plainFigures( '<p>a</p><figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube"><div class="wp-block-embed__wrapper">\nhttps://www.youtube.com/watch?v=x\n</div></figure>' )
		).toBe( '<p>a</p><p>https://www.youtube.com/watch?v=x</p>' );
	} );

	it( 'never reaches from a captioned table into the next table', () => {
		const html =
			'<figure class="wp-block-table"><table><tbody><tr><td>A</td></tr></tbody></table><figcaption>Cap</figcaption></figure><p>mid</p><figure class="wp-block-table"><table><tbody><tr><td>B</td></tr></tbody></table></figure>';

		expect( plainFigures( html ) ).toBe(
			'<figure class="wp-block-table"><table><tbody><tr><td>A</td></tr></tbody></table><figcaption>Cap</figcaption></figure><p>mid</p><table><tbody><tr><td>B</td></tr></tbody></table>'
		);
	} );

	it( 'keeps a figure that has a caption', () => {
		const html = '<figure class="wp-block-table"><table><tbody><tr><td>a</td></tr></tbody></table><figcaption class="wp-element-caption">C</figcaption></figure>';

		expect( plainFigures( html ) ).toBe( html );
	} );
} );

describe( 'withoutBlockMarkup and preformatted text', () => {
	it( 'keeps the blank lines inside a <pre>', () => {
		expect( withoutBlockMarkup( '<!-- wp:html -->\n<pre>l1\n\n\nl2</pre>\n<!-- /wp:html -->\n\n<!-- wp:paragraph -->\n<p>a</p>\n<!-- /wp:paragraph -->' ) ).toBe( '<pre>l1\n\n\nl2</pre>\n<p>a</p>' );
	} );
} );

describe( 'contentOf', () => {
	it( 'is the same for HTML that reads the same, and differs when text, an image or a link is lost', () => {
		const html = '<p><span style="color:red">Red</span> text <a href="/x">link</a></p><img src="a.jpg">';

		expect( contentOf( '<p>Red text <a href="/x">link</a></p>\n<figure><img src="a.jpg" alt=""/></figure>' ) ).toBe( contentOf( html ) );
		expect( contentOf( '<p>Red text link</p><img src="a.jpg">' ) ).not.toBe( contentOf( html ) );
		expect( contentOf( '<p>Red text <a href="/x">link</a></p>' ) ).not.toBe( contentOf( html ) );
		expect( contentOf( '<p>Red <a href="/x">link</a></p><img src="a.jpg">' ) ).not.toBe( contentOf( html ) );
	} );
} );
