/**
 * The Images field of the edit panel: the images editor (images-editor.tsx)
 * as a DataForm control. The panel says which row it edits through
 * `ImagesControlContext` (the form record holds field values only).
 */
import { createContext, useContext } from '@wordpress/element';
import type { DataFormControlProps } from '../../dataviews';
import type { RawImage } from '../../types';
import { ImagesEditor } from './images-editor';

export interface ImagesControlTarget {
	/** The product uploads are attached to (a variation's parent). */
	postId?: number;
	/** A variation: one image. */
	single: boolean;
	itemName?: string;
}

export const ImagesControlContext = createContext< ImagesControlTarget | null >( null );

export function ImagesControl< Item >( { data, field, onChange, hideLabelFromVision }: DataFormControlProps< Item > ) {
	const target = useContext( ImagesControlContext );
	const value = ( data as Record< string, unknown > )[ field.id ];
	const images = Array.isArray( value ) ? ( value as RawImage[] ) : [];
	const labelId = `wc-pl-images-label-${ field.id.replace( /[^a-z0-9_-]+/gi, '-' ) }`;

	return (
		<div className="wc-pl-images-control" role="group" aria-labelledby={ labelId }>
			<span id={ labelId } className={ hideLabelFromVision ? 'screen-reader-text' : 'wc-pl-images-control__label' }>
				{ field.label }
			</span>
			<ImagesEditor
				value={ images }
				onChange={ ( next ) => onChange( field.setValue ? field.setValue( { item: data, value: next } ) : ( { [ field.id ]: next } as Partial< Item > ) ) }
				single={ target?.single ?? false }
				postId={ target?.postId }
				itemName={ target?.itemName }
			/>
		</div>
	);
}
