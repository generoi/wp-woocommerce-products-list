/**
 * The control of an HTML field (short description, description and their
 * translations): a small formatted-text editor instead of a textarea full
 * of `<p>`, `<br />` and `&amp;`.
 *
 * - Visual (the default): the text as it reads, with Bold, Italic,
 *   bulleted and numbered lists and links; Cmd/Ctrl+B and +I work too.
 *   Pasting brings plain text, never another page's styles.
 * - Code: the HTML in a textarea, as before: the stored text for core's
 *   descriptions (the editor loads them in edit context, raw, shortcodes
 *   and all; `readContextOf()` in hydrate.ts).
 *
 * Round trip: nothing is written until the text is edited, so opening and
 * closing the editor never rewrites a description. Text stored without
 * paragraph tags (WordPress adds them on output, `wpautop`) is shown as
 * paragraphs and stored without them again; `<b>`/`<i>` from the browser's
 * own commands are stored as `<strong>`/`<em>`.
 *
 * The visual editor shows only HTML it can keep: a value with a script,
 * a style, an embed, a form control, an inline event handler, a
 * `javascript:` link or HTML comments (block markup) opens in Code, with
 * a note, so nothing is lost or run. The HTML is parsed in an inert
 * document (DOMParser) before any of it reaches the page.
 *
 * Part of the edit chunk: it loads with the editor, not with the list.
 */
import { Button } from '@wordpress/components';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { formatBold, formatItalic, formatListBullets, formatListNumbered, link as linkIcon, linkOff } from '@wordpress/icons';
import type { ClipboardEvent, ComponentType, KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { DataFormControlProps } from '../dataviews';
import type { FormData } from './bulk-numeric-control';

/** Elements the visual editor will not show (they would run, load something or be lost when edited). */
const UNSAFE_ELEMENTS = 'script, style, iframe, object, embed, form, input, textarea, select, button, link, meta, base, svg, math, template, frame, frameset, noscript';

/** Block-level tags: a value with one of them carries its own paragraphs. */
const BLOCK_TAG = /<(?:p|div|ul|ol|li|h[1-6]|table|blockquote|pre|figure|hr|dl|section|article|address)[\s>/]/i;

export type HtmlEditorMode = 'visual' | 'code';

function parse( html: string ): Document {
	return new DOMParser().parseFromString( `<!DOCTYPE html><html><body>${ html }</body></html>`, 'text/html' );
}

/** Why the visual editor cannot show this HTML, or null when it can. */
export function visualProblem( html: string ): string | null {
	if ( /<!--/.test( html ) ) {
		return __( 'This text has HTML comments (block markup), which the visual editor would not keep.', 'wp-woocommerce-products-list' );
	}

	const body = parse( html ).body;

	if ( body.querySelector( UNSAFE_ELEMENTS ) ) {
		return __( 'This text has embedded content or scripts, which the visual editor does not show.', 'wp-woocommerce-products-list' );
	}

	for ( const element of Array.from( body.querySelectorAll( '*' ) ) ) {
		for ( const attribute of Array.from( element.attributes ) ) {
			const name = attribute.name.toLowerCase();

			if ( name.startsWith( 'on' ) || ( [ 'href', 'src', 'action', 'formaction', 'xlink:href' ].includes( name ) && /^\s*(?:javascript|vbscript|data:text\/html)/i.test( attribute.value ) ) ) {
				return __( 'This text has scripted attributes, which the visual editor does not show.', 'wp-woocommerce-products-list' );
			}
		}
	}

	return null;
}

function escapeText( text: string ): string {
	return text.replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' );
}

/**
 * What the visual editor shows for a stored value: the value itself when it
 * has its own paragraphs, else paragraphs made from its blank lines and
 * line breaks from its single newlines, as `wpautop` does on the shop.
 */
export function toVisualHtml( value: string ): string {
	if ( value.trim() === '' ) {
		return '';
	}

	if ( BLOCK_TAG.test( value ) ) {
		return value;
	}

	return value
		.replace( /\r\n?/g, '\n' )
		.trim()
		.split( /\n\s*\n/ )
		.map( ( paragraph ) => `<p>${ paragraph.trim().replace( /\n/g, '<br>' ) }</p>` )
		.join( '' );
}

/** Rename an element, keeping its attributes and children. */
function rename( element: Element, tag: string ): void {
	const replacement = element.ownerDocument.createElement( tag );

	for ( const attribute of Array.from( element.attributes ) ) {
		replacement.setAttribute( attribute.name, attribute.value );
	}

	replacement.append( ...Array.from( element.childNodes ) );
	element.replaceWith( replacement );
}

/** A paragraph with nothing but a line break or whitespace in it: what an emptied editor leaves. */
function isEmptyBlock( element: Element ): boolean {
	return ( element.textContent ?? '' ).replace( /\u00a0/g, ' ' ).trim() === '' && ! element.querySelector( 'img, hr, br ~ br' );
}

/**
 * The value to store for what the visual editor holds: `<b>`/`<i>` as
 * `<strong>`/`<em>`, the browser's `<div>` paragraphs as `<p>`, no empty
 * trailing paragraph, and, when the stored value had no paragraph tags of
 * its own, none again (blank lines between paragraphs, newlines for line
 * breaks), so the shop's `wpautop` sees what it saw before.
 */
export function fromVisualHtml( html: string, original: string ): string {
	const body = parse( html ).body;

	body.querySelectorAll( 'b' ).forEach( ( element ) => rename( element, 'strong' ) );
	body.querySelectorAll( 'i' ).forEach( ( element ) => rename( element, 'em' ) );
	Array.from( body.children )
		.filter( ( element ) => element.tagName === 'DIV' && element.attributes.length === 0 )
		.forEach( ( element ) => rename( element, 'p' ) );

	// Chrome's span wrappers with inline styles from execCommand: keep the text only.
	body.querySelectorAll( 'span[style]' ).forEach( ( element ) => {
		if ( element.attributes.length === 1 ) {
			element.replaceWith( ...Array.from( element.childNodes ) );
		}
	} );

	while ( body.lastElementChild && /^(P|DIV)$/.test( body.lastElementChild.tagName ) && isEmptyBlock( body.lastElementChild ) && body.lastChild === body.lastElementChild ) {
		body.lastElementChild.remove();
	}

	// A lone trailing <br> the browser keeps so the caret has a line.
	if ( body.lastChild instanceof HTMLBRElement ) {
		body.lastChild.remove();
	}

	if ( ( body.textContent ?? '' ).replace( /\u00a0/g, ' ' ).trim() === '' && ! body.querySelector( 'img, hr' ) ) {
		return '';
	}

	const out = body.innerHTML;

	if ( BLOCK_TAG.test( original ) || original.trim() === '' ) {
		return out;
	}

	// The value relied on wpautop: store it without the paragraph tags it did not have.
	return out
		.replace( /<p>/g, '' )
		.replace( /<\/p>/g, '\n\n' )
		.replace( /<br\s*\/?>/g, '\n' )
		.replace( /\n{3,}/g, '\n\n' )
		.trim();
}

/**
 * The mode of the HTML fields in the open editor. Every editor opens in
 * Visual (`resetHtmlEditorMode`, called as it opens); Code stays only for
 * the editor it was picked in, never across sessions.
 */
let sessionMode: HtmlEditorMode = 'visual';

function readMode(): HtmlEditorMode {
	return sessionMode;
}

/** The mounted controls: a mode picked in one applies to every HTML field on screen. */
const modeListeners = new Set< ( mode: HtmlEditorMode ) => void >();

function writeMode( mode: HtmlEditorMode ): void {
	sessionMode = mode;
	modeListeners.forEach( ( listener ) => listener( mode ) );
}

/** Back to Visual: for a newly opened editor. */
export function resetHtmlEditorMode(): void {
	sessionMode = 'visual';
}

interface VisualEditorProps {
	id: string;
	labelId: string;
	describedBy?: string;
	value: string;
	rows: number;
	onChange( value: string ): void;
}

/** A toolbar button keeps the text selection: pressing it would otherwise move focus off the text first. */
function keepSelection( event: ReactMouseEvent ): void {
	event.preventDefault();
}

function exec( command: string, value?: string ): void {
	// execCommand is deprecated but still the only cross-browser way to format a contenteditable without an editor library.
	if ( typeof document.execCommand === 'function' ) {
		document.execCommand( command, false, value );
	}
}

/** The contenteditable part, with its toolbar. Its DOM is the browser's while typing; React only seeds it. */
function VisualEditor( { id, labelId, describedBy, value, rows, onChange }: VisualEditorProps ) {
	const editableRef = useRef< HTMLDivElement >( null );
	// What this editor last wrote: a value coming back as the same string needs no reseeding (that would move the caret).
	const emittedRef = useRef< string | null >( null );
	const originalRef = useRef( value );
	const rangeRef = useRef< Range | null >( null );
	const [ linkOpen, setLinkOpen ] = useState( false );
	const [ linkUrl, setLinkUrl ] = useState( '' );
	const linkInputRef = useRef< HTMLInputElement >( null );

	// Seed the editable from the value (on mount, and when the value changes from outside: a reset, an Undo, Code mode).
	useLayoutEffect( () => {
		const editable = editableRef.current;

		if ( ! editable || value === emittedRef.current ) {
			return;
		}

		const body = parse( toVisualHtml( value ) ).body;

		editable.replaceChildren( ...Array.from( body.childNodes ).map( ( node ) => document.importNode( node, true ) ) );
		// A value from outside (the load bringing the stored text) is what later edits are read back against.
		if ( emittedRef.current !== null ) {
			originalRef.current = value;
		}
		emittedRef.current = value;
	}, [ value ] );

	const emit = useCallback( () => {
		const editable = editableRef.current;

		if ( ! editable ) {
			return;
		}

		const next = fromVisualHtml( editable.innerHTML, originalRef.current );

		if ( next !== emittedRef.current ) {
			emittedRef.current = next;
			onChange( next );
		}
	}, [ onChange ] );

	const saveRange = () => {
		const selection = window.getSelection();
		const editable = editableRef.current;

		if ( selection && selection.rangeCount > 0 && editable?.contains( selection.getRangeAt( 0 ).commonAncestorContainer ) ) {
			rangeRef.current = selection.getRangeAt( 0 ).cloneRange();
		}
	};

	const restoreRange = () => {
		const selection = window.getSelection();

		editableRef.current?.focus();

		if ( selection && rangeRef.current ) {
			selection.removeAllRanges();
			selection.addRange( rangeRef.current );
		}
	};

	const run = ( command: string, argument?: string ) => {
		restoreRange();
		exec( command, argument );
		saveRange();
		emit();
	};

	const openLink = () => {
		saveRange();

		const anchor = rangeRef.current ? ( rangeRef.current.commonAncestorContainer.parentElement?.closest( 'a' ) ?? null ) : null;

		setLinkUrl( anchor?.getAttribute( 'href' ) ?? '' );
		setLinkOpen( true );
	};

	useEffect( () => {
		if ( linkOpen ) {
			linkInputRef.current?.focus();
		}
	}, [ linkOpen ] );

	const applyLink = () => {
		const url = linkUrl.trim();

		setLinkOpen( false );

		if ( url === '' ) {
			run( 'unlink' );

			return;
		}

		if ( /^\s*(?:javascript|vbscript|data):/i.test( url ) ) {
			return;
		}

		run( 'createLink', url );
	};

	const onLinkKeyDown = ( event: KeyboardEvent< HTMLInputElement > ) => {
		// Enter and Escape belong to the link box here, not to the editor (which would save or close).
		if ( event.key === 'Enter' ) {
			event.preventDefault();
			event.stopPropagation();
			applyLink();
		} else if ( event.key === 'Escape' ) {
			event.preventDefault();
			event.stopPropagation();
			setLinkOpen( false );
			restoreRange();
		}
	};

	const onKeyDown = ( event: KeyboardEvent< HTMLDivElement > ) => {
		if ( ( event.metaKey || event.ctrlKey ) && ! event.altKey && event.key.toLowerCase() === 'k' ) {
			event.preventDefault();
			openLink();
		}
	};

	const onPaste = ( event: ClipboardEvent< HTMLDivElement > ) => {
		const text = event.clipboardData?.getData( 'text/plain' );

		if ( typeof text !== 'string' ) {
			return;
		}

		event.preventDefault();

		// Plain text, its blank lines as paragraphs: never another page's markup or styles.
		const paragraphs = text.replace( /\r\n?/g, '\n' ).split( /\n\s*\n/ );

		if ( paragraphs.length < 2 ) {
			exec( 'insertText', text );
		} else {
			exec( 'insertHTML', paragraphs.map( ( paragraph ) => `<p>${ escapeText( paragraph.trim() ).replace( /\n/g, '<br>' ) }</p>` ).join( '' ) );
		}

		emit();
	};

	const tools = [
		{ command: 'bold', icon: formatBold, label: __( 'Bold', 'wp-woocommerce-products-list' ), shortcut: 'Ctrl+B' },
		{ command: 'italic', icon: formatItalic, label: __( 'Italic', 'wp-woocommerce-products-list' ), shortcut: 'Ctrl+I' },
		{ command: 'insertUnorderedList', icon: formatListBullets, label: __( 'Bulleted list', 'wp-woocommerce-products-list' ) },
		{ command: 'insertOrderedList', icon: formatListNumbered, label: __( 'Numbered list', 'wp-woocommerce-products-list' ) },
	];

	return (
		<>
			<div className="wc-pl-html-editor__toolbar" role="toolbar" aria-label={ __( 'Formatting', 'wp-woocommerce-products-list' ) } aria-controls={ id }>
				{ tools.map( ( tool ) => (
					<Button
						key={ tool.command }
						size="small"
						icon={ tool.icon }
						label={ tool.label }
						shortcut={ tool.shortcut }
						onMouseDown={ keepSelection }
						onClick={ () => run( tool.command ) }
					/>
				) ) }
				<Button size="small" icon={ linkIcon } label={ __( 'Link', 'wp-woocommerce-products-list' ) } shortcut="Ctrl+K" onMouseDown={ keepSelection } onClick={ openLink } />
				<Button size="small" icon={ linkOff } label={ __( 'Remove link', 'wp-woocommerce-products-list' ) } onMouseDown={ keepSelection } onClick={ () => run( 'unlink' ) } />
			</div>
			{ linkOpen ? (
				<div className="wc-pl-html-editor__link">
					<input
						ref={ linkInputRef }
						type="url"
						className="components-text-control__input"
						aria-label={ __( 'Link address', 'wp-woocommerce-products-list' ) }
						placeholder="https://"
						value={ linkUrl }
						onChange={ ( event ) => setLinkUrl( event.target.value ) }
						onKeyDown={ onLinkKeyDown }
					/>
					<Button variant="secondary" size="compact" onClick={ applyLink }>
						{ __( 'Apply', 'wp-woocommerce-products-list' ) }
					</Button>
					<Button
						variant="tertiary"
						size="compact"
						onClick={ () => {
							setLinkOpen( false );
							restoreRange();
						} }
					>
						{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
					</Button>
				</div>
			) : null }
			<div
				ref={ editableRef }
				id={ id }
				className="wc-pl-html-editor__visual"
				role="textbox"
				aria-multiline="true"
				aria-labelledby={ labelId }
				aria-describedby={ describedBy }
				contentEditable
				suppressContentEditableWarning
				style={ { minHeight: `${ Math.max( 3, rows ) * 1.6 }em` } }
				onFocus={ () => exec( 'defaultParagraphSeparator', 'p' ) }
				onInput={ emit }
				onBlur={ saveRange }
				onKeyUp={ saveRange }
				onMouseUp={ saveRange }
				onKeyDown={ onKeyDown }
				onPaste={ onPaste }
			/>
		</>
	);
}

/** The DataForm control of an HTML field: Visual / Code. `rows` sizes both. */
export function createHtmlTextControl( { rows = 4 }: { rows?: number } = {} ): ComponentType< DataFormControlProps< FormData > > {
	function HtmlTextControl( { data, field, onChange, hideLabelFromVision }: DataFormControlProps< FormData > ) {
		const uid = useId().replace( /:/g, '' );
		const id = `wc-pl-html-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }-${ uid }`;
		const labelId = `${ id }-label`;
		const helpId = `${ id }-help`;
		const raw = data[ field.id ];
		const value = raw === undefined || raw === null ? '' : String( raw );
		const problem = useMemo( () => visualProblem( value ), [ value ] );
		const [ chosen, setChosen ] = useState< HtmlEditorMode >( readMode );
		const mode: HtmlEditorMode = problem ? 'code' : chosen;
		const change = useCallback( ( next: string ) => onChange( { [ field.id ]: next } ), [ field.id, onChange ] );

		useEffect( () => {
			modeListeners.add( setChosen );

			return () => {
				modeListeners.delete( setChosen );
			};
		}, [] );

		const choose = ( next: HtmlEditorMode ) => writeMode( next );

		return (
			<div className={ `wc-pl-html-editor is-${ mode }` }>
				<div className="wc-pl-html-editor__head">
					<span id={ labelId } className={ `wc-pl-html-editor__label${ hideLabelFromVision ? ' screen-reader-text' : '' }` }>
						{ field.label }
					</span>
					<div className="wc-pl-html-editor__modes" role="group" aria-label={ __( 'Editor mode', 'wp-woocommerce-products-list' ) }>
						<Button size="small" isPressed={ mode === 'visual' } disabled={ !! problem } accessibleWhenDisabled onClick={ () => choose( 'visual' ) }>
							{ __( 'Visual', 'wp-woocommerce-products-list' ) }
						</Button>
						<Button size="small" isPressed={ mode === 'code' } onClick={ () => choose( 'code' ) }>
							{ __( 'Code', 'wp-woocommerce-products-list' ) }
						</Button>
					</div>
				</div>
				{ mode === 'visual' ? (
					<VisualEditor id={ id } labelId={ labelId } describedBy={ field.description ? helpId : undefined } value={ value } rows={ rows } onChange={ change } />
				) : (
					<textarea
						id={ id }
						className="components-textarea-control__input wc-pl-html-editor__code"
						aria-labelledby={ labelId }
						aria-describedby={ field.description ? helpId : undefined }
						rows={ rows }
						value={ value }
						onChange={ ( event ) => change( event.target.value ) }
					/>
				) }
				{ problem ? <p className="wc-pl-html-editor__note">{ problem }</p> : null }
				{ field.description ? (
					<p id={ helpId } className="components-base-control__help wc-pl-html-editor__help">
						{ field.description }
					</p>
				) : null }
			</div>
		);
	}

	return HtmlTextControl;
}
