/**
 * A description in the block editor, in a large modal over the quick edit
 * panel. One editor at a time, for the language tab chosen in the modal;
 * the default language's description shows alongside, read only, when
 * another language is edited. "Done" puts the edited texts back into the
 * form (saved with Update, as any field); Cancel drops them, after asking
 * when something was changed.
 *
 * The block editor is WordPress's own (window.wp.blockEditor), loaded the
 * first time the modal opens (load-block-editor.ts). Only a chosen set of
 * blocks is offered, without colours, font sizes or spacing.
 *
 * Storage stays plain HTML. A description stored as HTML (all of them so
 * far) opens as blocks, the way WordPress converts pasted HTML, and is
 * written back as HTML without block comments; text, links and images come
 * through unchanged (checked on all 848 widetoes descriptions, and checked
 * again each time one opens: one that would not, opens as a Classic block).
 * One stored with block markup keeps it. A language whose text was not edited is
 * never written back, so opening and closing the modal changes nothing.
 */
import { Button, Modal, Popover, SlotFillProvider, Spinner, __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';
import { Fragment, createElement, useCallback, useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { redo as redoIcon, undo as undoIcon } from '@wordpress/icons';
import type { KeyboardEvent } from 'react';
import { loadBlockEditor, serverSettings } from './load-block-editor';

/* The block editor packages are WordPress globals loaded at runtime; they are not bundled, so they are typed loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function wp(): Any {
	return ( window as unknown as { wp: Any } ).wp;
}

export const ALLOWED_BLOCKS = [
	'core/paragraph',
	'core/heading',
	'core/list',
	'core/list-item',
	'core/quote',
	'core/image',
	'core/embed',
	'core/separator',
	'core/table',
	'core/html',
	'core/freeform',
];

/** No colours, font sizes, spacing or borders: a description takes the shop's styles. */
const FEATURES = {
	color: { custom: false, customGradient: false, customDuotone: false, defaultPalette: false, defaultGradients: false, defaultDuotone: false, palette: {}, gradients: {}, duotone: {}, text: false, background: false, link: false },
	typography: { customFontSize: false, defaultFontSizes: false, fontSizes: {}, fontFamilies: {}, lineHeight: false, dropCap: false, fontStyle: false, fontWeight: false, letterSpacing: false, textTransform: false, textDecoration: false, textColumns: false, textIndent: false, fitText: false, writingMode: false, fluid: false },
	spacing: { padding: false, margin: false, blockGap: false, units: [] },
	border: { color: false, radius: false, style: false, width: false },
	dimensions: { minHeight: false, aspectRatio: false },
	shadow: { presets: {}, defaultPresets: false },
	layout: {},
};

export interface DescriptionLanguage {
	lang: string;
	label: string;
	fieldId: string;
	tabId: string;
	isDefault: boolean;
}

export interface DescriptionModalProps {
	languages: DescriptionLanguage[];
	/** The language the modal opens on. */
	initialFieldId: string;
	/** The form's current values (a language's value is there once its tab has loaded). */
	data: Record< string, unknown >;
	loadedTabs: ReadonlySet< string >;
	/** The panel's tab under the modal. */
	activeTab: string;
	/** Load a language's values: the panel switches to its tab. */
	showTab( tabId: string ): void;
	onApply( changes: Record< string, string > ): void;
	onClose(): void;
}

const stop = ( event: { stopPropagation(): void } ) => event.stopPropagation();

/** The React events the modal keeps to itself. */
const STOP_EVENTS = {
	onKeyDown: stop,
	onKeyUp: stop,
	onKeyPress: stop,
	onSubmit: stop,
	onChange: stop,
	onInput: stop,
	onFocus: stop,
	onBlur: stop,
	onMouseDown: stop,
	onClick: stop,
};

let blocksRegistered = false;
let mediaFilterAdded = false;

function prepareBlocks(): void {
	const w = wp();

	if ( ! blocksRegistered ) {
		blocksRegistered = true;

		// "Fit text" sizes text with a script on the shop, which a description stored as HTML does not carry; text
		// alignment comes back from HTML as a bare class name the toolbar no longer shows (or undoes).
		// Classic and Custom HTML stay for text that needs them (HTML no other block takes) but are not offered.
		w.hooks.addFilter( 'blocks.registerBlockType', 'wc-products-list/description-supports', ( settings: Any, name: string ) => {
			let supports = settings.supports ?? {};

			if ( supports.typography ) {
				supports = { ...supports, typography: { ...supports.typography, fitText: false, textAlign: false } };
			}

			if ( name === 'core/freeform' || name === 'core/html' ) {
				supports = { ...supports, inserter: false };
			}

			return supports === settings.supports ? settings : { ...settings, supports };
		} );

		// Core blocks may already be registered by another script on the page.
		if ( ! w.blocks.getBlockType( 'core/paragraph' ) ) {
			w.blockLibrary.registerCoreBlocks();
		}

		// HTML no block takes (rare) stays as a Classic block rather than being lost.
		w.blocks.setFreeformContentHandlerName?.( 'core/freeform' );

		// Formats a description has no use for; "math" also needs a script module this page does not load.
		for ( const name of [ 'core/math', 'core/footnote', 'core/keyboard', 'core/language', 'core/non-breaking-space' ] ) {
			if ( w.data.select( 'core/rich-text' ).getFormatType( name ) ) {
				w.richText.unregisterFormatType( name );
			}
		}
	}

	if ( ! mediaFilterAdded && w.mediaUtils?.MediaUpload ) {
		mediaFilterAdded = true;
		w.hooks.addFilter( 'editor.MediaUpload', 'wc-products-list/media-upload', () => w.mediaUtils.MediaUpload );
	}
}

/** Whether a stored description is block markup (kept as such) rather than HTML. */
export function isBlockMarkup( html: string ): boolean {
	return /<!--\s+wp:/.test( html );
}

/**
 * Tables and embeds the way WordPress reads them back from HTML: a table
 * without the editor's <figure> (and its fixed-layout class) around it, an
 * embed as its URL alone in a paragraph (which the shop turns into the
 * player). Pasted-HTML conversion takes neither figure back, so they would
 * reopen as raw HTML blocks. One with a caption keeps its figure: the
 * caption has nowhere else to go.
 */
export function plainFigures( html: string ): string {
	return html
		// The table's inside never crosses a figure: a captioned table must not reach into the next table's figure.
		.replace( /<figure class="wp-block-table[^"]*">\s*<table(?: class="has-fixed-layout")?>((?:(?!<\/?figure)[\s\S])*?<\/table>)\s*<\/figure>/g, '<table>$1' )
		.replace( /<figure class="wp-block-embed\b[^"]*">\s*<div class="wp-block-embed__wrapper">\s*(https?:\/\/[^\s<]+)\s*<\/div>\s*<\/figure>/g, '<p>$1</p>' );
}

/** What a reader gets from HTML: its text, images, links and embedded media (whitespace aside). */
export function contentOf( html: string ): string {
	const body = new DOMParser().parseFromString( html, 'text/html' ).body;
	const sources = ( selector: string, attribute: string ) =>
		Array.from( body.querySelectorAll( selector ) )
			.map( ( element ) => element.getAttribute( attribute ) ?? '' )
			.sort()
			.join( ' ' );

	return [ body.textContent?.replace( /\s+/g, '' ) ?? '', sources( 'img', 'src' ), sources( 'a', 'href' ), sources( 'iframe, video, audio, source', 'src' ) ].join( '|' );
}

/**
 * Blocks for a stored description: its block markup, or its HTML converted
 * as pasted HTML is. HTML the conversion would not keep whole (text, an
 * image, a link or a video lost on the way) opens as one Classic block
 * instead, which keeps it exactly.
 */
export function toBlocks( html: string ): Any[] {
	const w = wp();

	if ( html.trim() === '' ) {
		return [];
	}

	if ( isBlockMarkup( html ) ) {
		return w.blocks.parse( html );
	}

	const blocks = w.blocks.rawHandler( { HTML: plainFigures( html ) } );

	return contentOf( withoutBlockMarkup( w.blocks.serialize( blocks ) ) ) === contentOf( html ) ? blocks : [ w.blocks.createBlock( 'core/freeform', { content: html } ) ];
}

/**
 * Serialized blocks as plain HTML: no block comments, and none of the class
 * names the editor adds to plain elements ("wp-block-heading" on every
 * heading), and tables and embeds as plainFigures() has them, so the text
 * reads as it was written. Classes that carry styling (an image's size and
 * alignment) stay.
 */
export function withoutBlockMarkup( serialized: string ): string {
	return plainFigures( serialized.replace( /<!--\s+\/?wp:[^>]*?-->\n?/g, '' ) )
		.replace( / class="wp-block-(?:heading|list|paragraph)"/g, '' )
		.replace( /<hr class="wp-block-separator has-alpha-channel-opacity"\/>/g, '<hr>' )
		// Blank lines between elements only: inside a <pre> they are the text.
		.replace( />\n{2,}</g, '>\n<' )
		.trim();
}

/** Whether HTML has nothing to read or see: no text, no image, no embed (an empty paragraph the editor started is nothing). */
export function isEmptyHtml( html: string ): boolean {
	return ! /<(?:img|iframe|video|audio|hr|table)\b/i.test( html ) && ! /https?:\/\//.test( html ) && html.replace( /<[^>]*>/g, '' ).replace( /&nbsp;|\s/g, '' ) === '';
}

/** The stored form of edited blocks: HTML, or block markup when the description was stored that way; nothing for an empty editor. */
export function toStored( blocks: Any[], asBlockMarkup: boolean ): string {
	const serialized = wp().blocks.serialize( blocks );

	if ( isEmptyHtml( serialized ) ) {
		return '';
	}

	// Empty paragraphs before and after the text (the line left after an image, say) are not stored.
	return asBlockMarkup ? serialized : withoutBlockMarkup( serialized ).replace( /^(?:<p><\/p>\s*)+|(?:\s*<p><\/p>)+$/g, '' );
}

function stringValue( value: unknown ): string {
	return typeof value === 'string' ? value : '';
}

/** The default language's description, inert: no script runs in a sandboxed frame. */
function Reference( { html, label }: { html: string | null; label: string } ) {
	const heading = sprintf( /* translators: %s: language name */ __( '%s (for reference)', 'wp-woocommerce-products-list' ), label );

	if ( html === null ) {
		return (
			<section className="wc-pl-desc-modal__reference">
				<h3>{ heading }</h3>
				<p className="wc-pl-desc-modal__loading">
					<Spinner /> { __( 'Loading…', 'wp-woocommerce-products-list' ) }
				</p>
			</section>
		);
	}

	const doc = `<!doctype html><meta charset="utf-8"><style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1e1e1e;margin:16px 20px}img,iframe{max-width:100%;height:auto}h1,h2,h3,h4{line-height:1.25}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}</style>${ html || `<p style="color:#757575">${ __( 'No description.', 'wp-woocommerce-products-list' ) }</p>` }`;

	return (
		<section className="wc-pl-desc-modal__reference" aria-label={ heading }>
			<h3>{ heading }</h3>
			<iframe title={ heading } sandbox="" srcDoc={ doc } />
		</section>
	);
}

function isUndo( event: KeyboardEvent ): boolean {
	return ( event.metaKey || event.ctrlKey ) && ! event.altKey && event.key.toLowerCase() === 'z' && ! event.shiftKey;
}

function isRedo( event: KeyboardEvent ): boolean {
	return ( event.metaKey || event.ctrlKey ) && ! event.altKey && ( ( event.key.toLowerCase() === 'z' && event.shiftKey ) || ( event.ctrlKey && event.key.toLowerCase() === 'y' ) );
}

function Editor( { html, placeholder, autoFocus, onChange }: { html: string; placeholder: string; autoFocus: boolean; onChange( blocks: Any[] ): void } ) {
	const w = wp();
	const be = w.blockEditor;
	const initial = useMemo( () => {
			const blocks = toBlocks( html );

			// An empty description starts as an empty paragraph, ready to type in.
			return blocks.length ? blocks : [ w.blocks.createBlock( 'core/paragraph', { placeholder } ) ];
		},
		// The text the editor opened with; later edits live in the editor.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[] );
	const { value: blocks, setValue, hasUndo, hasRedo, undo, redo } = w.compose.useStateWithHistory( initial );
	const canvas = useRef< HTMLDivElement >( null );
	const settings = useMemo( () => ( {
		...serverSettings(),
		allowedBlockTypes: ALLOWED_BLOCKS,
		// The block's tools sit in the editor's own top bar: a toolbar floating over the text would cover the line
		// above and, scrolled away, stick out over the modal's header.
		hasFixedToolbar: true,
		bodyPlaceholder: placeholder,
		colors: [],
		gradients: [],
		fontSizes: [],
		disableCustomColors: true,
		disableCustomGradients: true,
		disableCustomFontSizes: true,
		enableCustomLineHeight: false,
		enableCustomSpacing: false,
		__experimentalFeatures: FEATURES,
		// No patterns (they are the theme's page sections) and no stock photos from Openverse.
		__experimentalBlockPatterns: [],
		__experimentalBlockPatternCategories: [],
		enableOpenverseMediaCategory: false,
		// The link box finds the shop's own pages, products and categories, as in the post editor.
		...( w.coreData?.__experimentalFetchLinkSuggestions
			? { __experimentalFetchLinkSuggestions: ( search: string, options: Any ) => w.coreData.__experimentalFetchLinkSuggestions( search, options, {} ) }
			: {} ),
		...( w.coreData?.__experimentalFetchUrlData ? { __experimentalFetchRichUrlData: w.coreData.__experimentalFetchUrlData } : {} ),
		mediaUpload: w.mediaUtils?.uploadMedia
			? ( { filesList, onFileChange, allowedTypes, onError }: Any ) =>
					w.mediaUtils.uploadMedia( { filesList, onFileChange, allowedTypes, onError: ( error: Any ) => onError?.( error?.message ?? String( error ) ) } )
			: undefined,
	} ),
	// eslint-disable-next-line react-hooks/exhaustive-deps
	[] );

	// Typing is staged (one undo step per burst, as in WordPress's editors); other changes are steps of their own.
	const input = ( next: Any[] ) => {
		setValue( next, true );
		onChange( next );
	};
	const change = ( next: Any[] ) => {
		setValue( next, false );
		onChange( next );
	};
	// Undo and redo replace the blocks, which drops the selection: focus stays in the editor so the next Cmd+Z works.
	const step = ( apply: () => void ) => ( event?: KeyboardEvent ) => {
		event?.preventDefault();
		apply();
		window.requestAnimationFrame( () => {
			if ( canvas.current && ! canvas.current.contains( document.activeElement ) ) {
				canvas.current.focus();
			}
		} );
	};

	useEffect( () => {
		if ( hasUndo || hasRedo ) {
			onChange( blocks );
		}
		// Undo and redo change the blocks without the provider's onChange.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ blocks ] );

	// Put the cursor in the text, in the first block.
	useEffect( () => {
		if ( ! autoFocus ) {
			return;
		}

		const timer = window.setTimeout( () => {
			canvas.current?.querySelector< HTMLElement >( '[contenteditable="true"]' )?.focus();
		}, 0 );

		return () => window.clearTimeout( timer );
		// On mount only.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [] );

	const Typing = be.ObserveTyping ?? Fragment;
	const Shortcuts = w.keyboardShortcuts?.ShortcutProvider;
	// The shortcut provider is a <div>: it takes the editor's place in the layout.
	const Wrapper = Shortcuts ?? 'div';

	return (
		<Wrapper className="wc-pl-desc-modal__shortcuts">
			<be.BlockEditorProvider value={ blocks } onInput={ input } onChange={ change } settings={ settings }>
				{ be.BlockEditorKeyboardShortcuts?.Register ? createElement( be.BlockEditorKeyboardShortcuts.Register ) : null }
				<div
					className="wc-pl-desc-modal__editor"
					onKeyDown={ ( event ) => {
						if ( isRedo( event ) ) {
							step( redo )( event );
						} else if ( isUndo( event ) ) {
							step( undo )( event );
						}
					} }
				>
					<div className="wc-pl-desc-modal__toolbar" role="toolbar" aria-label={ __( 'Description tools', 'wp-woocommerce-products-list' ) }>
						<be.Inserter position="bottom right" />
						<Button size="compact" icon={ undoIcon } label={ __( 'Undo', 'wp-woocommerce-products-list' ) } shortcut="⌘Z" disabled={ ! hasUndo } accessibleWhenDisabled onClick={ () => undo() } />
						<Button size="compact" icon={ redoIcon } label={ __( 'Redo', 'wp-woocommerce-products-list' ) } shortcut="⇧⌘Z" disabled={ ! hasRedo } accessibleWhenDisabled onClick={ () => redo() } />
						<div className="wc-pl-desc-modal__block-toolbar">
							<be.BlockToolbar hideDragHandle />
						</div>
						<span className="wc-pl-desc-modal__hint">{ __( 'Type / in an empty line to add a heading, list, image or table.', 'wp-woocommerce-products-list' ) }</span>
					</div>
					<div className="wc-pl-desc-modal__canvas editor-styles-wrapper" ref={ canvas } tabIndex={ -1 }>
						<be.BlockTools>
							<be.WritingFlow>
								<Typing>
									{ /* "Type / to choose a block" after the last block: a place to click to write on. */ }
									<be.BlockList renderAppender={ be.DefaultBlockAppender } />
								</Typing>
							</be.WritingFlow>
						</be.BlockTools>
					</div>
					<aside className="wc-pl-desc-modal__inspector" aria-label={ __( 'Block settings', 'wp-woocommerce-products-list' ) }>
						<be.BlockInspector />
					</aside>
				</div>
			</be.BlockEditorProvider>
		</Wrapper>
	);
}

export function DescriptionModal( { languages, initialFieldId, data, loadedTabs, activeTab, showTab, onApply, onClose }: DescriptionModalProps ) {
	const [ ready, setReady ] = useState( false );
	const [ failed, setFailed ] = useState< string | null >( null );
	const [ fieldId, setFieldId ] = useState( initialFieldId );
	// Edited values by field: what Done writes back.
	const [ edits, setEdits ] = useState< Record< string, string > >( {} );
	// What each language's text serializes to when it opens: an edit that comes back to it is no change.
	const [ baselines, setBaselines ] = useState< Record< string, string > >( {} );
	// Bumped to reopen the editor on new content (the default language's text copied in).
	const [ generation, setGeneration ] = useState( 0 );
	const [ confirming, setConfirming ] = useState( false );
	// Whether the next editor to open takes focus: not when the language changed from the tabs by keyboard.
	const [ editorTakesFocus, setEditorTakesFocus ] = useState( true );
	const current = languages.find( ( entry ) => entry.fieldId === fieldId ) ?? languages[ 0 ];
	const reference = languages.find( ( entry ) => entry.isDefault );
	const loaded = current ? loadedTabs.has( current.tabId ) : false;

	useEffect( () => {
		let cancelled = false;

		loadBlockEditor()
			.then( () => {
				if ( ! cancelled ) {
					prepareBlocks();
					setReady( true );
				}
			} )
			.catch( ( error: unknown ) => ! cancelled && setFailed( error instanceof Error ? error.message : String( error ) ) );

		return () => {
			cancelled = true;
		};
	}, [] );

	const showsReference = !! ( current && ! current.isDefault && reference );
	const referenceLoaded = reference ? loadedTabs.has( reference.tabId ) : false;

	// The panel loads a tab's values when it shows that tab: the reference language's first, then the edited one's;
	// the panel ends on the edited language.
	useEffect( () => {
		if ( ! current ) {
			return;
		}

		if ( showsReference && reference && ! referenceLoaded ) {
			showTab( reference.tabId );
		} else if ( ! loaded || activeTab !== current.tabId ) {
			showTab( current.tabId );
		}
	}, [ current, loaded, showsReference, reference, referenceLoaded, activeTab, showTab ] );

	const valueOf = useCallback( ( id: string ) => edits[ id ] ?? stringValue( data[ id ] ), [ edits, data ] );
	const value = current ? valueOf( current.fieldId ) : '';
	const referenceHtml = reference && referenceLoaded ? valueOf( reference.fieldId ) : null;

	const baselineMissing = !! ( ready && loaded && current && baselines[ current.fieldId ] === undefined );

	useEffect( () => {
		if ( baselineMissing && current ) {
			const stored = stringValue( data[ current.fieldId ] );

			setBaselines( ( previous ) => ( { ...previous, [ current.fieldId ]: stored.trim() === '' ? '' : toStored( toBlocks( stored ), isBlockMarkup( stored ) ) } ) );
		}
	}, [ baselineMissing, current, data ] );

	const changed = Object.keys( edits ).filter( ( id ) => edits[ id ] !== baselines[ id ] && edits[ id ] !== stringValue( data[ id ] ) );

	const done = () => {
		onApply( Object.fromEntries( changed.map( ( id ) => [ id, edits[ id ] ?? '' ] ) ) );
		onClose();
	};
	const requestClose = () => ( changed.length ? setConfirming( true ) : onClose() );

	const startFromReference = () => {
		if ( current && referenceHtml ) {
			setEditorTakesFocus( true );
			setEdits( ( previous ) => ( { ...previous, [ current.fieldId ]: referenceHtml } ) );
			setGeneration( ( previous ) => previous + 1 );
		}
	};

	return (
		// The modal is a portal, but React still bubbles its events to the quick edit form around it, where Cmd+Enter
		// saves the product, Shift+Enter (a line break here) saves and opens the next one and a submit (the table
		// block's "Create table") updates and closes the panel: they stop here.
		<div className="wc-pl-desc-modal__boundary" { ...STOP_EVENTS }>
			<Modal
				title={ sprintf( /* translators: %s: language name */ __( 'Description – %s', 'wp-woocommerce-products-list' ), current?.label ?? '' ) }
				onRequestClose={ requestClose }
				className="wc-pl-desc-modal"
				overlayClassName="wc-pl-desc-modal__overlay"
				isFullScreen
				shouldCloseOnClickOutside={ false }
				headerActions={
					<div className="wc-pl-desc-modal__actions">
						<Button variant="tertiary" onClick={ requestClose }>
							{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
						</Button>
						<Button variant="primary" onClick={ done } shortcut="⌘↵">
							{ __( 'Done', 'wp-woocommerce-products-list' ) }
						</Button>
					</div>
				}
			>
				<div
					className="wc-pl-desc-modal__layout"
					onKeyDown={ ( event ) => {
						if ( ( event.metaKey || event.ctrlKey ) && event.key === 'Enter' ) {
							event.preventDefault();
							done();
						}
					} }
				>
					{ /* Arrow keys, Home and End move between the languages; Tab goes on to the editor. */ }
					<div
						className="wc-pl-desc-modal__tabs"
						role="tablist"
						aria-label={ __( 'Language', 'wp-woocommerce-products-list' ) }
						onKeyDown={ ( event ) => {
							const index = languages.findIndex( ( entry ) => entry.fieldId === fieldId );
							const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: languages.length - 1 }[ event.key ];

							if ( next === undefined ) {
								return;
							}

							event.preventDefault();
							const target = languages[ ( next + languages.length ) % languages.length ];

							if ( target ) {
								// Focus stays on the tabs: the editor of the language takes it only when clicked or opened.
								setEditorTakesFocus( false );
								setFieldId( target.fieldId );
								event.currentTarget.querySelector< HTMLElement >( `[data-field="${ target.fieldId }"]` )?.focus();
							}
						} }
					>
						{ languages.map( ( entry ) => (
							<Button
								key={ entry.fieldId }
								data-field={ entry.fieldId }
								role="tab"
								tabIndex={ entry.fieldId === fieldId ? 0 : -1 }
								aria-selected={ entry.fieldId === fieldId }
								className="wc-pl-desc-modal__tab"
								isPressed={ entry.fieldId === fieldId }
								onClick={ () => {
									setEditorTakesFocus( true );
									setFieldId( entry.fieldId );
								} }
							>
								{ entry.label }
								{ changed.includes( entry.fieldId ) ? (
									<span className="wc-pl-desc-modal__dot" title={ __( 'Changed', 'wp-woocommerce-products-list' ) }>
										<span className="screen-reader-text">{ __( '(changed)', 'wp-woocommerce-products-list' ) }</span>
									</span>
								) : null }
							</Button>
						) ) }
					</div>
					<div className={ `wc-pl-desc-modal__body${ showsReference ? ' has-reference' : '' }` }>
						{ showsReference && reference ? <Reference html={ referenceHtml } label={ reference.label } /> : null }
						<div className="wc-pl-desc-modal__main">
							{ failed ? <p className="wc-pl-desc-modal__error">{ sprintf( /* translators: %s: error message */ __( 'The block editor could not be loaded: %s', 'wp-woocommerce-products-list' ), failed ) }</p> : null }
							{ ! failed && ( ! ready || ! loaded ) ? (
								<p className="wc-pl-desc-modal__loading">
									<Spinner /> { ready ? __( 'Loading this language…', 'wp-woocommerce-products-list' ) : __( 'Loading the block editor…', 'wp-woocommerce-products-list' ) }
								</p>
							) : null }
							{ ready && loaded && current && showsReference && reference && isEmptyHtml( value ) && referenceHtml && ! isEmptyHtml( referenceHtml ) ? (
								<div className="wc-pl-desc-modal__empty">
									<span>{ sprintf( /* translators: %s: language name */ __( 'No %s description yet.', 'wp-woocommerce-products-list' ), current.label ) }</span>
									<Button variant="secondary" size="compact" onClick={ startFromReference }>
										{ sprintf( /* translators: %s: language name */ __( 'Start from the %s text', 'wp-woocommerce-products-list' ), reference.label ) }
									</Button>
								</div>
							) : null }
							{ ready && loaded && current ? (
								<SlotFillProvider>
									<Editor
										key={ `${ current.fieldId }:${ generation }` }
										html={ value }
									autoFocus={ editorTakesFocus }
										placeholder={ sprintf( /* translators: %s: language name */ __( 'Write the %s description…', 'wp-woocommerce-products-list' ), current.label ) }
										onChange={ ( blocks ) => setEdits( ( previous ) => ( { ...previous, [ current.fieldId ]: toStored( blocks, isBlockMarkup( stringValue( data[ current.fieldId ] ) ) ) } ) ) }
									/>
									<Popover.Slot />
								</SlotFillProvider>
							) : null }
						</div>
					</div>
				</div>
				{ confirming ? (
					<ConfirmDialog
						isOpen
						confirmButtonText={ __( 'Discard changes', 'wp-woocommerce-products-list' ) }
						cancelButtonText={ __( 'Keep editing', 'wp-woocommerce-products-list' ) }
						onConfirm={ onClose }
						onCancel={ () => setConfirming( false ) }
					>
						{ sprintf(
							/* translators: %s: comma-separated language names */
							__( 'Discard your changes to the description (%s)?', 'wp-woocommerce-products-list' ),
							languages.filter( ( entry ) => changed.includes( entry.fieldId ) ).map( ( entry ) => entry.label ).join( ', ' )
						) }
					</ConfirmDialog>
				) : null }
			</Modal>
		</div>
	);
}
