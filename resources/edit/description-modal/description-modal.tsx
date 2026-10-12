/**
 * Prototype: a description in the block editor, in a large modal over the
 * quick edit panel. One editor at a time, for the language tab chosen in
 * the modal; the default language's description shows alongside, read
 * only, when another language is edited. "Done" puts the edited texts back
 * into the form (saved with Update, as any field); Cancel drops them.
 *
 * The block editor is WordPress's own (window.wp.blockEditor), loaded the
 * first time the modal opens (load-block-editor.ts). Only a chosen set of
 * blocks is offered. A description stored as plain HTML (most of them)
 * opens as one Classic block and is written back as plain HTML unless
 * someone converts it to blocks.
 */
import { Button, Modal, Popover, SlotFillProvider, Spinner } from '@wordpress/components';
import { Fragment, createElement, useCallback, useEffect, useMemo, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { loadBlockEditor } from './load-block-editor';

/* The block editor packages are WordPress globals loaded at runtime; they are not bundled, so they are typed loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function wp(): Any {
	return ( window as unknown as { wp: Any } ).wp;
}

export const ALLOWED_BLOCKS = [ 'core/paragraph', 'core/heading', 'core/list', 'core/list-item', 'core/image', 'core/separator', 'core/table', 'core/freeform' ];

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

/** When the last language switch was clicked (one modal is open at a time). */
const clock: { switchStarted: number | null } = { switchStarted: null };

let blocksRegistered = false;
let mediaFilterAdded = false;

function prepareBlocks(): void {
	const w = wp();

	if ( ! blocksRegistered ) {
		blocksRegistered = true;

		// Core blocks may already be registered by another script on the page.
		if ( ! w.blocks.getBlockType( 'core/paragraph' ) ) {
			w.blockLibrary.registerCoreBlocks();
		}

		// Plain HTML (no block markup) opens as a Classic block.
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

/** Blocks for a stored description: its block markup, or the whole HTML as one Classic block. */
export function toBlocks( html: string ): Any[] {
	const w = wp();

	if ( html.trim() === '' ) {
		return [];
	}

	if ( /<!--\s+wp:/.test( html ) ) {
		return w.blocks.parse( html );
	}

	return [ w.blocks.createBlock( 'core/freeform', { content: withoutGapsBetweenBlocks( html ) } ) ];
}

const BLOCK_TAGS = 'h[1-6]|p|ul|ol|li|hr|table|thead|tbody|tr|td|th|div|blockquote|figure';

/**
 * Whitespace between block elements ("</h3> <ul>") makes TinyMCE wrap the
 * whole text in a <div>, which "Convert to blocks" cannot turn into blocks.
 * Only the gaps between block tags go; text and inline spacing stay.
 */
export function withoutGapsBetweenBlocks( html: string ): string {
	return html.replace( new RegExp( `(</?(?:${ BLOCK_TAGS })(?:\\s[^>]*)?/?>)\\s+(?=</?(?:${ BLOCK_TAGS })[\\s>/])`, 'gi' ), '$1' );
}

function stringValue( value: unknown ): string {
	return typeof value === 'string' ? value : '';
}

/** The default language's description, inert: no script runs in a sandboxed frame. */
function Reference( { html, label }: { html: string | null; label: string } ) {
	if ( html === null ) {
		return (
			<section className="wc-pl-desc-modal__reference">
				<h3>{ sprintf( /* translators: %s: language name */ __( '%s (reference)', 'wp-woocommerce-products-list' ), label ) }</h3>
				<p className="wc-pl-desc-modal__loading">
					<Spinner /> { __( 'Loading…', 'wp-woocommerce-products-list' ) }
				</p>
			</section>
		);
	}

	const doc = `<!doctype html><meta charset="utf-8"><style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1e1e1e;margin:12px 16px}img{max-width:100%;height:auto}h1,h2,h3,h4{line-height:1.25}</style>${ html || `<p style="color:#757575">${ __( 'No description.', 'wp-woocommerce-products-list' ) }</p>` }`;

	return (
		<section className="wc-pl-desc-modal__reference" aria-label={ sprintf( /* translators: %s: language name */ __( '%s description (reference)', 'wp-woocommerce-products-list' ), label ) }>
			<h3>{ sprintf( /* translators: %s: language name */ __( '%s (reference)', 'wp-woocommerce-products-list' ), label ) }</h3>
			<iframe title={ label } sandbox="" srcDoc={ doc } />
		</section>
	);
}

function Editor( { initial, onChange }: { initial: Any[]; onChange( blocks: Any[] ): void } ) {
	const be = wp().blockEditor;
	const [ blocks, setBlocks ] = useState< Any[] >( initial );
	const settings = useMemo( () => {
		const w = wp();

		return {
			allowedBlockTypes: ALLOWED_BLOCKS,
			hasFixedToolbar: false,
			bodyPlaceholder: __( 'Write the description…', 'wp-woocommerce-products-list' ),
			mediaUpload: w.mediaUtils?.uploadMedia
				? ( { filesList, onFileChange, allowedTypes, onError }: Any ) =>
						w.mediaUtils.uploadMedia( { filesList, onFileChange, allowedTypes, onError: ( error: Any ) => onError?.( error?.message ?? String( error ) ) } )
				: undefined,
		};
	}, [] );
	const change = ( next: Any[] ) => {
		setBlocks( next );
		onChange( next );
	};
	const Typing = be.ObserveTyping ?? Fragment;
	const Shortcuts = wp().keyboardShortcuts?.ShortcutProvider ?? Fragment;

	return (
		<Shortcuts>
			<be.BlockEditorProvider value={ blocks } onInput={ change } onChange={ change } settings={ settings }>
				{ be.BlockEditorKeyboardShortcuts?.Register ? createElement( be.BlockEditorKeyboardShortcuts.Register ) : null }
				<div className="wc-pl-desc-modal__editor">
				<div className="wc-pl-desc-modal__canvas editor-styles-wrapper">
					<be.BlockTools>
						<be.WritingFlow>
							<Typing>
								<be.BlockList />
							</Typing>
						</be.WritingFlow>
					</be.BlockTools>
				</div>
				<aside className="wc-pl-desc-modal__inspector" aria-label={ __( 'Block settings', 'wp-woocommerce-products-list' ) }>
					<be.BlockInspector />
				</aside>
				</div>
			</be.BlockEditorProvider>
		</Shortcuts>
	);
}

export function DescriptionModal( { languages, initialFieldId, data, loadedTabs, activeTab, showTab, onApply, onClose }: DescriptionModalProps ) {
	const [ ready, setReady ] = useState( false );
	const [ failed, setFailed ] = useState< string | null >( null );
	const [ fieldId, setFieldId ] = useState( initialFieldId );
	// Edited values by field: what Done writes back.
	const [ edits, setEdits ] = useState< Record< string, string > >( {} );
	const [ timing, setTiming ] = useState< { load?: number; switch?: number } >( {} );
	const current = languages.find( ( entry ) => entry.fieldId === fieldId ) ?? languages[ 0 ];
	const reference = languages.find( ( entry ) => entry.isDefault );
	const loaded = current ? loadedTabs.has( current.tabId ) : false;

	useEffect( () => {
		let cancelled = false;

		loadBlockEditor()
			.then( ( ms ) => {
				if ( cancelled ) {
					return;
				}

				prepareBlocks();
				setTiming( ( previous ) => ( { ...previous, load: ms } ) );
				 
				console.info( `[wc-products-list] block editor ${ ms ? `loaded in ${ Math.round( ms ) } ms` : 'already loaded' }` );
				setReady( true );
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

	const value = current ? edits[ current.fieldId ] ?? stringValue( data[ current.fieldId ] ) : '';
	const initial = useMemo( () => ( ready && loaded ? toBlocks( value ) : [] ),
		// Parsed when the language (or its load) changes, not on every keystroke.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[ ready, loaded, fieldId ] );

	useEffect( () => {
		if ( ready && loaded && clock.switchStarted !== null ) {
			const ms = performance.now() - clock.switchStarted;

			clock.switchStarted = null;
			setTiming( ( previous ) => ( { ...previous, switch: ms } ) );
		}
	}, [ ready, loaded, fieldId ] );

	const choose = useCallback( ( next: DescriptionLanguage ) => {
		clock.switchStarted = performance.now();
		setFieldId( next.fieldId );
	}, [] );

	const changed = Object.keys( edits ).filter( ( id ) => edits[ id ] !== stringValue( data[ id ] ) );

	return (
		<Modal
			title={ sprintf( /* translators: %s: language name */ __( 'Description – %s', 'wp-woocommerce-products-list' ), current?.label ?? '' ) }
			onRequestClose={ onClose }
			className="wc-pl-desc-modal"
			overlayClassName="wc-pl-desc-modal__overlay"
			isFullScreen
			shouldCloseOnClickOutside={ false }
			headerActions={
				<div className="wc-pl-desc-modal__actions">
					<Button variant="tertiary" onClick={ onClose }>
						{ __( 'Cancel', 'wp-woocommerce-products-list' ) }
					</Button>
					<Button
						variant="primary"
						onClick={ () => {
							onApply( Object.fromEntries( changed.map( ( id ) => [ id, edits[ id ] ?? '' ] ) ) );
							onClose();
						} }
					>
						{ __( 'Done', 'wp-woocommerce-products-list' ) }
					</Button>
				</div>
			}
		>
			<div className="wc-pl-desc-modal__tabs" role="tablist" aria-label={ __( 'Language', 'wp-woocommerce-products-list' ) }>
				{ languages.map( ( entry ) => (
					<Button
						key={ entry.fieldId }
						role="tab"
						aria-selected={ entry.fieldId === fieldId }
						className="wc-pl-desc-modal__tab"
						isPressed={ entry.fieldId === fieldId }
						onClick={ () => choose( entry ) }
					>
						{ entry.label }
						{ changed.includes( entry.fieldId ) ? <span className="wc-pl-desc-modal__dot" aria-label={ __( 'changed', 'wp-woocommerce-products-list' ) } /> : null }
					</Button>
				) ) }
			</div>
			<div className={ `wc-pl-desc-modal__body${ showsReference ? ' has-reference' : '' }` }>
				{ showsReference && reference ? <Reference html={ referenceLoaded ? stringValue( edits[ reference.fieldId ] ?? data[ reference.fieldId ] ) : null } label={ reference.label } /> : null }
				<div className="wc-pl-desc-modal__main">
					{ failed ? <p className="wc-pl-desc-modal__error">{ failed }</p> : null }
					{ ! failed && ( ! ready || ! loaded ) ? (
						<p className="wc-pl-desc-modal__loading">
							<Spinner /> { ready ? __( 'Loading this language…', 'wp-woocommerce-products-list' ) : __( 'Loading the block editor…', 'wp-woocommerce-products-list' ) }
						</p>
					) : null }
					{ ready && loaded && current ? (
						<SlotFillProvider>
							<Editor
								key={ current.fieldId }
								initial={ initial }
								onChange={ ( blocks ) => setEdits( ( previous ) => ( { ...previous, [ current.fieldId ]: wp().blocks.serialize( blocks ) } ) ) }
							/>
							<Popover.Slot />
						</SlotFillProvider>
					) : null }
				</div>
			</div>
			<p className="wc-pl-desc-modal__timing">
				{ timing.load !== undefined ? sprintf( /* translators: %d: milliseconds */ __( 'Prototype · editor loaded in %d ms', 'wp-woocommerce-products-list' ), Math.round( timing.load ) ) : null }
				{ timing.switch !== undefined ? ` · ${ sprintf( /* translators: %d: milliseconds */ __( 'last language switch %d ms', 'wp-woocommerce-products-list' ), Math.round( timing.switch ) ) }` : null }
			</p>
		</Modal>
	);
}
