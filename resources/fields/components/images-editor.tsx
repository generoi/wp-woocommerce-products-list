/**
 * A product's images as the product screen keeps them: the first is the
 * main (featured) image, the rest the gallery. A variation has one image.
 *
 * Images are picked or uploaded in the media library, or dropped on the
 * editor as files (uploaded at once). Mouse users drag a tile to reorder
 * (onto the first tile to make it the main image); every move is also in
 * the tile's menu, for the keyboard and screen readers, and announced.
 */
import { speak } from '@wordpress/a11y';
import { DropdownMenu } from '@wordpress/components';
import { useEffect, useLayoutEffect, useRef, useState } from '@wordpress/element';
import { decodeEntities } from '@wordpress/html-entities';
import { __, _n, sprintf } from '@wordpress/i18n';
import { closeSmall, moreVertical, plus } from '@wordpress/icons';
import type { DragEvent } from 'react';
import { isImageFile, pickImages, uploadImage } from '../../media/media-frame';
import type { RawImage } from '../../types';
import { getSettings } from '../../settings';
import { Button, Spinner } from '../../ui';

export interface ImagesEditorProps {
	value: RawImage[];
	onChange: ( next: RawImage[] ) => void;
	/** One image only (a variation). */
	single?: boolean;
	/** The product uploads are attached to. */
	postId?: number;
	/** What the images are of, for the media library's title ("Images of Aylla Chiri"). */
	itemName?: string;
	disabled?: boolean;
	/** Called while an upload or the media library is busy (a save waits for it). */
	onBusyChange?: ( busy: boolean ) => void;
}

interface Upload {
	key: string;
	name: string;
}

/** Moves the entry at `from` to `to` (both in range). */
export function moveImage( images: RawImage[], from: number, to: number ): RawImage[] {
	if ( from === to || from < 0 || to < 0 || from >= images.length || to >= images.length ) {
		return images;
	}

	const next = images.slice();
	const [ moved ] = next.splice( from, 1 );

	next.splice( to, 0, moved as RawImage );

	return next;
}

/** `images` with `added` appended, an image already there kept once (where it was). */
export function addImages( images: RawImage[], added: RawImage[] ): RawImage[] {
	const known = new Set( images.map( ( image ) => image.id ) );
	const next = images.slice();

	for ( const image of added ) {
		if ( ! known.has( image.id ) ) {
			known.add( image.id );
			next.push( image );
		}
	}

	return next;
}

/** `images` with the one at `index` replaced (a replacement already elsewhere in the list moves here). */
export function replaceImage( images: RawImage[], index: number, replacement: RawImage ): RawImage[] {
	return images.map( ( image, i ) => ( i === index ? replacement : image ) ).filter( ( image, i ) => i === index || image.id !== replacement.id );
}

function imageLabel( image: RawImage, index: number ): string {
	const name = decodeEntities( image.alt || image.name || '' ).trim();

	if ( index === 0 ) {
		return name ? sprintf( /* translators: %s: image name */ __( 'Main image: %s', 'wp-woocommerce-products-list' ), name ) : __( 'Main image', 'wp-woocommerce-products-list' );
	}

	return name
		? sprintf( /* translators: 1: position in the gallery, 2: image name */ __( 'Gallery image %1$d: %2$s', 'wp-woocommerce-products-list' ), index, name )
		: sprintf( /* translators: %d: position in the gallery */ __( 'Gallery image %d', 'wp-woocommerce-products-list' ), index );
}

let uploadKeys = 0;

export function ImagesEditor( { value, onChange, single = false, postId, itemName, disabled = false, onBusyChange }: ImagesEditorProps ) {
	const [ uploads, setUploads ] = useState< Upload[] >( [] );
	const [ error, setError ] = useState< string | null >( null );
	const [ dragFrom, setDragFrom ] = useState< number | null >( null );
	const [ dropAt, setDropAt ] = useState< number | null >( null );
	const [ filesOver, setFilesOver ] = useState( false );
	const busyRef = useRef( 0 );
	// The latest value: uploads finish after renders that may have changed it.
	const valueRef = useRef( value );

	useLayoutEffect( () => {
		valueRef.current = value;
	}, [ value ] );

	// Unmounted mid-upload (the tab or the panel closed): whoever waits is not left waiting.
	const busyChangeRef = useRef( onBusyChange );

	useLayoutEffect( () => {
		busyChangeRef.current = onBusyChange;
	}, [ onBusyChange ] );

	useEffect(
		() => () => {
			if ( busyRef.current > 0 ) {
				busyChangeRef.current?.( false );
			}
		},
		[]
	);

	const images = single ? value.slice( 0, 1 ) : value;
	// Without `upload_files` there is no media library to pick from: images can be reordered and removed only.
	const canUpload = getSettings().caps.upload !== false;
	const busy = ( delta: number ) => {
		const before = busyRef.current > 0;

		busyRef.current = Math.max( 0, busyRef.current + delta );

		if ( before !== busyRef.current > 0 ) {
			onBusyChange?.( busyRef.current > 0 );
		}
	};

	const set = ( next: RawImage[], message?: string ) => {
		onChange( single ? next.slice( -1 ) : next );

		if ( message ) {
			speak( message );
		}
	};

	const title = ( base: string ) => ( itemName ? `${ base }: ${ decodeEntities( itemName ) }` : base );

	const pick = async ( index: number | null ) => {
		setError( null );
		busy( 1 );

		try {
			const replacing = index !== null ? images[ index ] : undefined;
			const picked = await pickImages( {
				title: title( replacing || single ? __( 'Choose image', 'wp-woocommerce-products-list' ) : __( 'Add images', 'wp-woocommerce-products-list' ) ),
				button: replacing || single ? __( 'Use this image', 'wp-woocommerce-products-list' ) : __( 'Add to product', 'wp-woocommerce-products-list' ),
				multiple: ! single && index === null,
				selected: replacing ? [ replacing.id ] : [],
				postId,
			} );

			if ( ! picked ) {
				return;
			}

			const current = valueRef.current;

			if ( single ) {
				set( picked.slice( 0, 1 ), __( 'Image set.', 'wp-woocommerce-products-list' ) );
			} else if ( index !== null && picked[ 0 ] ) {
				set( replaceImage( current, index, picked[ 0 ] ), __( 'Image replaced.', 'wp-woocommerce-products-list' ) );
			} else {
				const next = addImages( current, picked );
				const added = next.length - current.length;

				set( next, sprintf( /* translators: %d: number of images */ _n( '%d image added.', '%d images added.', added, 'wp-woocommerce-products-list' ), added ) );
			}
		} catch ( caught ) {
			setError( caught instanceof Error ? caught.message : String( caught ) );
		} finally {
			busy( -1 );
		}
	};

	const upload = async ( files: File[] ) => {
		const accepted = files.filter( isImageFile );
		const rejected = files.length - accepted.length;

		setError( rejected ? __( 'Only image files can be added here.', 'wp-woocommerce-products-list' ) : null );

		const batch = ( single ? accepted.slice( 0, 1 ) : accepted ).map( ( file ) => ( { file, key: `upload-${ ++uploadKeys }` } ) );

		if ( ! batch.length ) {
			return;
		}

		setUploads( ( current ) => [ ...current, ...batch.map( ( { file, key } ) => ( { key, name: file.name } ) ) ] );
		speak( sprintf( /* translators: %d: number of files */ _n( 'Uploading %d image…', 'Uploading %d images…', batch.length, 'wp-woocommerce-products-list' ), batch.length ) );
		busy( 1 );

		const failures: string[] = [];

		try {
			// One at a time, in the order dropped, so the gallery keeps that order.
			for ( const { file, key } of batch ) {
				try {
					const image = await uploadImage( file, postId );

					set( single ? [ image ] : addImages( valueRef.current, [ image ] ) );
				} catch ( caught ) {
					failures.push( `${ file.name }: ${ caught instanceof Error ? caught.message : String( ( caught as { message?: unknown } )?.message ?? caught ) }` );
				} finally {
					setUploads( ( current ) => current.filter( ( entry ) => entry.key !== key ) );
				}
			}
		} finally {
			busy( -1 );
		}

		if ( failures.length ) {
			setError( failures.join( ' ' ) );
			speak( failures.join( ' ' ), 'assertive' );
		} else {
			speak( sprintf( /* translators: %d: number of images */ _n( '%d image uploaded.', '%d images uploaded.', batch.length, 'wp-woocommerce-products-list' ), batch.length ) );
		}
	};

	const hasFiles = ( event: DragEvent ) => Array.from( event.dataTransfer?.types ?? [] ).includes( 'Files' );

	const onZoneDragOver = ( event: DragEvent ) => {
		if ( disabled || ! canUpload || ! hasFiles( event ) ) {
			return;
		}

		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
		setFilesOver( true );
	};

	const onZoneDrop = ( event: DragEvent ) => {
		if ( disabled || ! canUpload || ! hasFiles( event ) ) {
			return;
		}

		event.preventDefault();
		setFilesOver( false );
		void upload( Array.from( event.dataTransfer.files ) );
	};

	const onTileDragStart = ( event: DragEvent, index: number ) => {
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData( 'text/plain', String( images[ index ]?.id ?? '' ) );
		setDragFrom( index );
	};

	const onTileDragOver = ( event: DragEvent, index: number ) => {
		if ( dragFrom === null ) {
			return;
		}

		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
		setDropAt( index );
	};

	const onTileDrop = ( event: DragEvent, index: number ) => {
		if ( dragFrom === null ) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		const from = dragFrom;

		setDragFrom( null );
		setDropAt( null );

		if ( from !== index ) {
			set( moveImage( valueRef.current, from, index ), index === 0 ? __( 'Set as the main image.', 'wp-woocommerce-products-list' ) : sprintf( /* translators: %d: new position */ __( 'Moved to position %d.', 'wp-woocommerce-products-list' ), index + 1 ) );
		}
	};

	const rootRef = useRef< HTMLDivElement | null >( null );

	/** A moved tile is a moved DOM node, which loses the focus: it goes back to the tile's options. */
	const refocusTile = ( id: number ) =>
		window.requestAnimationFrame( () => rootRef.current?.querySelector< HTMLElement >( `[data-image-id="${ id }"] .wc-pl-images__tool` )?.focus() );

	const move = ( index: number, to: number, message: string ) => {
		const id = images[ index ]?.id;

		set( moveImage( images, index, to ), message );

		if ( id ) {
			refocusTile( id );
		}
	};

	const remove = ( index: number ) => {
		set(
			images.filter( ( _image, i ) => i !== index ),
			__( 'Image removed.', 'wp-woocommerce-products-list' )
		);

		// The focus was on the removed tile's button: it goes to the tile now in its place (or the one before), else "Add images".
		window.requestAnimationFrame( () => {
			const tiles = Array.from( rootRef.current?.querySelectorAll< HTMLElement >( '.wc-pl-images__tile:not(.is-add):not(.is-uploading)' ) ?? [] );
			const tile = tiles[ Math.min( index, tiles.length - 1 ) ];

			( tile?.querySelector< HTMLElement >( '.wc-pl-images__tool' ) ?? rootRef.current?.querySelector< HTMLElement >( '.wc-pl-images__add' ) )?.focus();
		} );
	};

	const canAdd = ! disabled && canUpload && ( ! single || images.length === 0 );
	const hint = single
		? images.length === 0
			? __( 'Until one is set, the variation shows the product’s main image. Drop an image file here, or choose one from the media library.', 'wp-woocommerce-products-list' )
			: __( 'Drop an image file here to replace it, or choose another from the media library.', 'wp-woocommerce-products-list' )
		: __( 'The first image is the main image, the others the gallery. Drag to reorder, or drop image files here to upload them.', 'wp-woocommerce-products-list' );

	return (
		<div
			ref={ rootRef }
			className={ `wc-pl-images${ filesOver ? ' is-files-over' : '' }${ disabled ? ' is-disabled' : '' }` }
			onDragOver={ onZoneDragOver }
			onDragLeave={ ( event ) => {
				if ( ! event.currentTarget.contains( event.relatedTarget as Node | null ) ) {
					setFilesOver( false );
				}
			} }
			onDrop={ onZoneDrop }
		>
			<ul className="wc-pl-images__list">
				{ images.map( ( image, index ) => (
					<li
						key={ image.id }
						data-image-id={ image.id }
						className={ [ 'wc-pl-images__tile', index === 0 ? 'is-main' : '', dragFrom === index ? 'is-dragging' : '', dropAt === index && dragFrom !== index ? 'is-drop-target' : '' ].filter( Boolean ).join( ' ' ) }
						draggable={ ! disabled && ! single && images.length > 1 }
						onDragStart={ ( event ) => onTileDragStart( event, index ) }
						onDragOver={ ( event ) => onTileDragOver( event, index ) }
						onDrop={ ( event ) => onTileDrop( event, index ) }
						onDragEnd={ () => {
							setDragFrom( null );
							setDropAt( null );
						} }
					>
						<img src={ image.src } alt={ imageLabel( image, single ? 0 : index ) } draggable={ false } />
						{ index === 0 && ! single && images.length > 1 && <span className="wc-pl-images__badge">{ __( 'Main', 'wp-woocommerce-products-list' ) }</span> }
						{ ! disabled && ( single || index === 0 ) && (
							// The main image (a variation's one): Replace and Remove over it, as the product screen's featured image has.
							<div className="wc-pl-images__actions">
								{ canUpload && (
									<Button
										size="compact"
										className="wc-pl-images__tool"
										label={ sprintf( /* translators: %s: e.g. "Main image: Boot" */ __( 'Replace %s', 'wp-woocommerce-products-list' ), imageLabel( image, 0 ) ) }
										onClick={ () => void pick( 0 ) }
									>
										{ __( 'Replace', 'wp-woocommerce-products-list' ) }
									</Button>
								) }
								<Button
									size="compact"
									className="wc-pl-images__tool"
									label={ sprintf( /* translators: %s: e.g. "Gallery image 2" */ __( 'Remove %s', 'wp-woocommerce-products-list' ), imageLabel( image, 0 ) ) }
									onClick={ () => remove( 0 ) }
								>
									{ __( 'Remove', 'wp-woocommerce-products-list' ) }
								</Button>
							</div>
						) }
						{ ! disabled && ! single && index > 0 && (
							<div className="wc-pl-images__tools">
								<DropdownMenu
									icon={ moreVertical }
									label={ sprintf( /* translators: %s: e.g. "Gallery image 2" */ __( 'Options for %s', 'wp-woocommerce-products-list' ), imageLabel( image, index ) ) }
									toggleProps={ { size: 'small', className: 'wc-pl-images__tool' } }
									popoverProps={ { placement: 'bottom-end' } }
									controls={ [
										{
											title: __( 'Set as main image', 'wp-woocommerce-products-list' ),
											onClick: () => move( index, 0, __( 'Set as the main image.', 'wp-woocommerce-products-list' ) ),
										},
										...( index > 1
											? [
													{
														title: __( 'Move earlier', 'wp-woocommerce-products-list' ),
														onClick: () => move( index, index - 1, sprintf( /* translators: %d: new position */ __( 'Moved to position %d.', 'wp-woocommerce-products-list' ), index ) ),
													},
											  ]
											: [] ),
										...( index < images.length - 1
											? [
													{
														title: __( 'Move later', 'wp-woocommerce-products-list' ),
														onClick: () => move( index, index + 1, sprintf( /* translators: %d: new position */ __( 'Moved to position %d.', 'wp-woocommerce-products-list' ), index + 2 ) ),
													},
											  ]
											: [] ),
										...( canUpload ? [ { title: __( 'Replace…', 'wp-woocommerce-products-list' ), onClick: () => void pick( index ) } ] : [] ),
									] }
								/>
								<Button
									size="small"
									icon={ closeSmall }
									className="wc-pl-images__tool"
									label={ sprintf( /* translators: %s: e.g. "Gallery image 2" */ __( 'Remove %s', 'wp-woocommerce-products-list' ), imageLabel( image, index ) ) }
									onClick={ () => remove( index ) }
								/>
							</div>
						) }
					</li>
				) ) }
				{ uploads.map( ( entry ) => (
					<li key={ entry.key } className="wc-pl-images__tile is-uploading" aria-label={ sprintf( /* translators: %s: file name */ __( 'Uploading %s', 'wp-woocommerce-products-list' ), entry.name ) }>
						<Spinner />
					</li>
				) ) }
				{ canAdd && uploads.length === 0 && (
					<li className="wc-pl-images__tile is-add">
						<Button className="wc-pl-images__add" icon={ plus } onClick={ () => void pick( null ) }>
							{ single || images.length === 0 ? __( 'Set image', 'wp-woocommerce-products-list' ) : __( 'Add images', 'wp-woocommerce-products-list' ) }
						</Button>
					</li>
				) }
			</ul>
			{ ! disabled && canUpload && <p className="wc-pl-images__hint">{ hint }</p> }
			{ error && (
				<p className="wc-pl-images__error" role="alert">
					{ error }
				</p>
			) }
		</div>
	);
}
