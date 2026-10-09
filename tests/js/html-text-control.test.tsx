/**
 * HTML fields edit as formatted text: decoded, no raw `<p>` or `&amp;`,
 * with a Code view, and the stored HTML is only rewritten when edited.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from '@wordpress/element';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHtmlTextControl, fromVisualHtml, resetHtmlEditorMode, toVisualHtml, visualProblem } from '../../resources/edit/html-text-control';

const Control = createHtmlTextControl( { rows: 4 } );

function Harness( { initial, onChange }: { initial: string; onChange?: ( value: string ) => void } ) {
	const [ data, setData ] = useState< Record< string, unknown > >( { short_description: initial } );

	return (
		<Control
			data={ data as never }
			field={ { id: 'short_description', label: 'Short description', description: 'Default: Lyhyt kuvaus' } as never }
			onChange={ ( patch: Record< string, unknown > ) => {
				setData( ( current ) => ( { ...current, ...patch } ) );
				onChange?.( patch.short_description as string );
			} }
		/>
	);
}

afterEach( () => {
	window.localStorage.clear();
	resetHtmlEditorMode();
} );

describe( 'toVisualHtml / fromVisualHtml', () => {
	it( 'shows text stored without paragraph tags as paragraphs, and stores it without them again', () => {
		const stored = 'First line\nsecond line\n\nSecond paragraph & more';

		expect( toVisualHtml( stored ) ).toBe( '<p>First line<br>second line</p><p>Second paragraph & more</p>' );
		expect( fromVisualHtml( '<p>First line<br>second line</p><p>Second paragraph &amp; more, edited</p>', stored ) ).toBe(
			'First line\nsecond line\n\nSecond paragraph &amp; more, edited'
		);
	} );

	it( 'keeps HTML with its own paragraphs as it is, with <b>/<i> stored as <strong>/<em>', () => {
		const stored = '<p>Omaking &amp; Fresh</p>\n<ul>\n<li>Lateksia</li>\n</ul>';

		expect( toVisualHtml( stored ) ).toBe( stored );
		expect( fromVisualHtml( '<p><b>Omaking</b> &amp; <i>Fresh</i></p><ul><li>Lateksia</li></ul><p><br></p>', stored ) ).toBe(
			'<p><strong>Omaking</strong> &amp; <em>Fresh</em></p><ul><li>Lateksia</li></ul>'
		);
		// The browser's <div> paragraphs become <p>.
		expect( fromVisualHtml( '<p>One</p><div>Two</div>', stored ) ).toBe( '<p>One</p><p>Two</p>' );
	} );

	it( 'stores an emptied editor as an empty string', () => {
		expect( fromVisualHtml( '<p><br></p>', '<p>Old</p>' ) ).toBe( '' );
		expect( fromVisualHtml( '<br>', 'Old' ) ).toBe( '' );
	} );

	it( 'leaves HTML it cannot keep to the Code view', () => {
		expect( visualProblem( '<p>Plain</p><table><tr><td>1</td></tr></table><img src="a.jpg">' ) ).toBeNull();
		expect( visualProblem( '<p>x</p><script>alert(1)</script>' ) ).not.toBeNull();
		expect( visualProblem( '<img src="x" onerror="alert(1)">' ) ).not.toBeNull();
		expect( visualProblem( '<a href="javascript:alert(1)">x</a>' ) ).not.toBeNull();
		expect( visualProblem( '<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->' ) ).not.toBeNull();
		expect( visualProblem( '<iframe src="https://example.com"></iframe>' ) ).not.toBeNull();
	} );
} );

describe( 'HtmlTextControl', () => {
	it( 'shows the text decoded in the visual editor, without writing anything until it is edited', () => {
		const onChange = vi.fn();

		render( <Harness initial={ '<p>Kengännauhat &amp; pohjalliset<br />\nToinen rivi</p>' } onChange={ onChange } /> );

		const box = screen.getByRole( 'textbox', { name: 'Short description' } );

		expect( box.getAttribute( 'contenteditable' ) ).toBe( 'true' );
		expect( box.textContent ).toContain( 'Kengännauhat & pohjalliset' );
		expect( box.textContent ).not.toContain( '&amp;' );
		expect( box.textContent ).not.toContain( '<br' );
		expect( box.querySelector( 'br' ) ).not.toBeNull();
		expect( screen.getByRole( 'toolbar', { name: 'Formatting' } ) ).toBeTruthy();
		expect( screen.getByText( 'Default: Lyhyt kuvaus' ) ).toBeTruthy();
		expect( onChange ).not.toHaveBeenCalled();

		// An edit in the visual editor writes HTML.
		box.innerHTML = '<p>Uusi &amp; parempi</p>';
		fireEvent.input( box );
		expect( onChange ).toHaveBeenLastCalledWith( '<p>Uusi &amp; parempi</p>' );
	} );

	it( 'opens in Visual in a new editor even after Code was picked in the last one, and ignores an old stored mode', () => {
		window.localStorage.setItem( 'wc-products-list:html-editor-mode', 'code' );
		const first = render( <Harness initial={ '<p>Yksi&nbsp;kaksi</p>' } /> );

		fireEvent.click( screen.getByRole( 'button', { name: 'Code' } ) );
		expect( ( screen.getByRole( 'textbox', { name: 'Short description' } ) as HTMLElement ).tagName ).toBe( 'TEXTAREA' );
		first.unmount();

		resetHtmlEditorMode();
		render( <Harness initial={ '<p>Yksi&nbsp;kaksi</p>' } /> );

		const box = screen.getByRole( 'textbox', { name: 'Short description' } ) as HTMLElement;

		expect( box.tagName ).toBe( 'DIV' );
		// Entities read as text in Visual, and stay entities in what is stored.
		expect( box.textContent ).toBe( 'Yksi\u00a0kaksi' );
		expect( fromVisualHtml( box.innerHTML, '<p>Yksi&nbsp;kaksi</p>' ) ).toBe( '<p>Yksi&nbsp;kaksi</p>' );
		window.localStorage.removeItem( 'wc-products-list:html-editor-mode' );
	} );

	it( 'switches to Code and back', async () => {
		render( <Harness initial={ '<p>Yksi</p>' } /> );

		fireEvent.click( screen.getByRole( 'button', { name: 'Code' } ) );

		const textarea = screen.getByRole( 'textbox', { name: 'Short description' } ) as HTMLTextAreaElement;

		expect( textarea.tagName ).toBe( 'TEXTAREA' );
		expect( textarea.value ).toBe( '<p>Yksi</p>' );

		fireEvent.change( textarea, { target: { value: '<p>Kaksi &amp; kolme</p>' } } );
		await act( async () => {
			fireEvent.click( screen.getByRole( 'button', { name: 'Visual' } ) );
		} );

		expect( screen.getByRole( 'textbox', { name: 'Short description' } ).textContent ).toBe( 'Kaksi & kolme' );
	} );

	it( 'opens HTML with scripts or block comments in Code, with a note, and never puts it in the page', () => {
		render( <Harness initial={ '<p>x</p><img src="x" onerror="window.__ran = 1">' } /> );

		expect( ( screen.getByRole( 'textbox', { name: 'Short description' } ) as HTMLElement ).tagName ).toBe( 'TEXTAREA' );
		expect( screen.getByRole( 'button', { name: 'Visual' } ).getAttribute( 'aria-disabled' ) ).toBe( 'true' );
		expect( screen.getByText( /scripted attributes/ ) ).toBeTruthy();
		expect( document.querySelector( 'img[onerror]' ) ).toBeNull();
	} );

	it( 'keeps Enter in the link box from saving the editor', () => {
		const formKeyDown = vi.fn();

		render(
			<form onKeyDown={ formKeyDown }>
				<Harness initial={ '<p>Linkki</p>' } />
			</form>
		);

		fireEvent.click( screen.getByRole( 'button', { name: 'Link' } ) );

		const input = screen.getByRole( 'textbox', { name: 'Link address' } );

		fireEvent.change( input, { target: { value: 'https://example.com' } } );
		fireEvent.keyDown( input, { key: 'Enter' } );
		expect( formKeyDown ).not.toHaveBeenCalled();
		expect( screen.queryByRole( 'textbox', { name: 'Link address' } ) ).toBeNull();
	} );
} );
