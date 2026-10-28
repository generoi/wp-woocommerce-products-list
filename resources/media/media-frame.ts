/**
 * The WordPress media library, as the product screen uses it: a frame to
 * pick (or upload) images, and uploads of files dropped on the image
 * editor. `wp.media` is loaded on first use (load-block-editor.ts), not
 * with the list.
 */
import apiFetch from '@wordpress/api-fetch';
import { __ } from '@wordpress/i18n';
import { loadMedia } from '../edit/description-modal/load-block-editor';
import type { RawImage } from '../types';

/** What the media library's models give for an attachment (`attachment.toJSON()`), the keys used here. */
export interface AttachmentJson {
	id: number;
	url?: string;
	alt?: string;
	title?: string;
	type?: string;
	sizes?: Record< string, { url: string } | undefined >;
}

interface MediaSelection {
	toJSON(): AttachmentJson[];
	add( models: unknown ): void;
	reset(): void;
}

interface MediaFrame {
	on( event: string, callback: () => void ): void;
	off( event: string ): void;
	open(): void;
	close(): void;
	state(): { get( key: 'selection' ): MediaSelection };
	dispose?(): void;
	detach?(): void;
}

interface WpMedia {
	( options: Record< string, unknown > ): MediaFrame;
	attachment( id: number ): { fetch(): unknown };
	model?: { settings?: { post?: { id?: number } } };
	view?: { settings?: { post?: { id?: number } } };
}

function media(): WpMedia {
	const wp = ( window as unknown as { wp?: { media?: WpMedia } } ).wp;

	if ( ! wp?.media ) {
		throw new Error( __( 'The media library could not be loaded.', 'wp-woocommerce-products-list' ) );
	}

	return wp.media;
}

/** The size the list and the editor show an image at: the thumbnail, else the smallest there is. */
export function toRawImage( attachment: AttachmentJson ): RawImage {
	const sizes = attachment.sizes ?? {};
	const src = sizes.thumbnail?.url ?? sizes.medium?.url ?? sizes.large?.url ?? attachment.url ?? '';

	return { id: attachment.id, src, alt: attachment.alt ?? '', name: attachment.title ?? '' };
}

export interface PickImagesOptions {
	title: string;
	button: string;
	/** Pick several (added in the order picked). */
	multiple?: boolean;
	/** Attachments ticked when the frame opens (the image being replaced). */
	selected?: number[];
	/** The product uploads are attached to (as on the product screen). */
	postId?: number;
}

const MEDIA_OPEN_CLASS = 'wc-pl-media-open';

/** Whether a frame is open: the image editor's popover stays open while focus is in it. */
let openFrames = 0;

export function isMediaFrameOpen(): boolean {
	return openFrames > 0;
}

/**
 * Opens the media library to pick images; resolves with them, or null when
 * the frame was closed without picking. Uploading in the frame works as on
 * the product screen.
 */
export async function pickImages( options: PickImagesOptions ): Promise< RawImage[] | null > {
	await loadMedia();

	const wpMedia = media();
	const settings = [ wpMedia.model?.settings, wpMedia.view?.settings ].filter( ( entry ): entry is { post?: { id?: number } } => !! entry );
	const previous = settings.map( ( entry ) => entry.post?.id );

	if ( options.postId ) {
		settings.forEach( ( entry ) => {
			entry.post = { ...( entry.post ?? {} ), id: options.postId };
		} );
	}

	const frame = wpMedia( {
		title: options.title,
		button: { text: options.button },
		multiple: options.multiple ? 'add' : false,
		library: { type: 'image' },
	} );

	return new Promise( ( resolve ) => {
		let picked: RawImage[] | null = null;

		frame.on( 'open', () => {
			const selection = frame.state().get( 'selection' );

			selection.reset();

			for ( const id of options.selected ?? [] ) {
				const attachment = wpMedia.attachment( id );

				attachment.fetch();
				selection.add( attachment );
			}
		} );

		frame.on( 'select', () => {
			picked = frame
				.state()
				.get( 'selection' )
				.toJSON()
				.filter( ( attachment ) => ! attachment.type || attachment.type === 'image' )
				.map( toRawImage );
		} );

		// `close` follows `select` too; resolved once, after the frame's own focus handling.
		frame.on( 'close', () => {
			openFrames = Math.max( 0, openFrames - 1 );

			if ( ! openFrames ) {
				document.body.classList.remove( MEDIA_OPEN_CLASS );
			}
			settings.forEach( ( entry, index ) => {
				entry.post = { ...( entry.post ?? {} ), id: previous[ index ] };
			} );
			window.setTimeout( () => {
				frame.detach?.();
				resolve( picked && picked.length ? picked : null );
			}, 0 );
		} );

		openFrames++;
		// Popovers (the list's image editor) sit above modals; under the media library while it is open.
		document.body.classList.add( MEDIA_OPEN_CLASS );
		frame.open();
	} );
}

/** Image types the uploader takes from a drop (the media library's own check runs on the server). */
export function isImageFile( file: File ): boolean {
	return /^image\//.test( file.type );
}

/** Uploads one image to the media library, attached to `postId`; resolves with it as a row image. */
export async function uploadImage( file: File, postId?: number ): Promise< RawImage > {
	const body = new FormData();

	body.append( 'file', file, file.name );

	if ( postId ) {
		body.append( 'post', String( postId ) );
	}

	const attachment = await apiFetch< { id: number; source_url?: string; alt_text?: string; title?: { rendered?: string }; media_details?: { sizes?: Record< string, { source_url: string } | undefined > } } >( {
		path: '/wp/v2/media',
		method: 'POST',
		body,
	} );
	const sizes = attachment.media_details?.sizes ?? {};

	return {
		id: attachment.id,
		src: sizes.thumbnail?.source_url ?? sizes.medium?.source_url ?? attachment.source_url ?? '',
		alt: attachment.alt_text ?? '',
		name: attachment.title?.rendered ?? file.name,
	};
}
