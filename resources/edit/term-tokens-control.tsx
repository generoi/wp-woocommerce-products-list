/**
 * The token control for list fields with known options (categories, tags,
 * brands): the user types and picks term NAMES, the form keeps term IDS.
 *
 * DataViews' own array control offers the element values (the ids) as
 * suggestions, so typing "Ballerinat" found nothing, typing "1" listed the
 * ids, and a typed name became a token the save turned into `{id: null}`
 * (WooCommerce reads that as "no terms"). Here suggestions are the labels,
 * a token must be one of them (anything else is refused and announced), and
 * only known ids ever reach `onChange`.
 */
import { FormTokenField, Spinner } from '@wordpress/components';
import { useEffect, useMemo, useState } from '@wordpress/element';
import { decodeEntities } from '@wordpress/html-entities';
import { __, sprintf } from '@wordpress/i18n';
import type { ComponentType } from 'react';
import type { DataFormControlProps, Option } from '../dataviews';
import type { FormData } from './bulk-numeric-control';

export interface TermTokenMaps {
	/** Id → the token text shown and suggested (the name; "Name (#id)" when two terms share it). */
	labelOf: Map< string, string >;
	/** Lower-cased token text → id. */
	idOf: Map< string, string >;
	suggestions: string[];
}

/** The two-way map between term ids and the names the user types. */
export function termTokenMaps( elements: Option[] ): TermTokenMaps {
	const names = elements.map( ( element ) => decodeEntities( String( element.label ?? element.value ) ).trim() );
	const counts = new Map< string, number >();

	names.forEach( ( name ) => counts.set( name.toLowerCase(), ( counts.get( name.toLowerCase() ) ?? 0 ) + 1 ) );

	const labelOf = new Map< string, string >();
	const idOf = new Map< string, string >();
	const suggestions: string[] = [];

	elements.forEach( ( element, index ) => {
		const id = String( element.value );
		const name = names[ index ]!;
		const text = ( counts.get( name.toLowerCase() ) ?? 0 ) > 1 ? `${ name } (#${ id })` : name;

		labelOf.set( id, text );
		idOf.set( text.toLowerCase(), id );
		suggestions.push( text );
	} );

	return { labelOf, idOf, suggestions };
}

/**
 * The ids for the tokens the control reports: a known name maps to its id, a
 * token already in the value (an id shown as itself, its term unknown) stays,
 * anything else is dropped.
 */
export function tokensToIds( tokens: Array< string | { value: string } >, maps: TermTokenMaps, current: string[] ): string[] {
	const out: string[] = [];

	for ( const token of tokens ) {
		const text = ( typeof token === 'string' ? token : token.value ).trim();
		const id = maps.idOf.get( text.toLowerCase() ) ?? ( current.includes( text ) && ! maps.labelOf.has( text ) ? text : undefined );

		if ( id !== undefined && ! out.includes( id ) ) {
			out.push( id );
		}
	}

	return out;
}

function useElementList( field: DataFormControlProps< FormData >[ 'field' ] ): { elements: Option[]; loading: boolean } {
	const [ loaded, setLoaded ] = useState< Option[] | null >( null );
	const getElements = ( field as { getElements?: () => Promise< Option[] > } ).getElements;
	const own = field.elements;

	useEffect( () => {
		if ( own?.length || ! getElements ) {
			return undefined;
		}

		let live = true;

		getElements().then(
			( list ) => live && setLoaded( list ?? [] ),
			() => live && setLoaded( [] )
		);

		return () => {
			live = false;
		};
	}, [ own, getElements ] );

	if ( own?.length ) {
		return { elements: own, loading: false };
	}

	return { elements: loaded ?? [], loading: !! getElements && loaded === null };
}

export function createTermTokensControl(): ComponentType< DataFormControlProps< FormData > > {
	function TermTokensControl( { data, field, onChange, hideLabelFromVision }: DataFormControlProps< FormData > ) {
		const { elements, loading } = useElementList( field );
		const maps = useMemo( () => termTokenMaps( elements ), [ elements ] );
		const raw = field.getValue( { item: data } );
		const current = Array.isArray( raw ) ? raw.map( String ) : [];
		const value = current.map( ( id ) => maps.labelOf.get( id ) ?? id );

		if ( loading ) {
			return <Spinner />;
		}

		return (
			<FormTokenField
				__next40pxDefaultSize
				__nextHasNoMarginBottom
				label={ hideLabelFromVision ? undefined : field.label }
				value={ value }
				suggestions={ maps.suggestions }
				placeholder={ field.placeholder }
				disabled={ field.isDisabled?.( { item: data, field } ) }
				__experimentalExpandOnFocus={ maps.suggestions.length > 0 }
				help={ field.description || undefined }
				__experimentalValidateInput={ ( token: string ) => maps.idOf.has( token.trim().toLowerCase() ) }
				messages={ {
					added: __( 'Term added.', 'wp-woocommerce-products-list' ),
					removed: __( 'Term removed.', 'wp-woocommerce-products-list' ),
					remove: __( 'Remove term', 'wp-woocommerce-products-list' ),
					__experimentalInvalid: sprintf(
						/* translators: %s: field label such as "Categories" */
						__( 'Not an existing term. Pick one from the %s list.', 'wp-woocommerce-products-list' ),
						field.label
					),
				} }
				onChange={ ( tokens ) => onChange( field.setValue( { item: data, value: tokensToIds( tokens as Array< string | { value: string } >, maps, current ) } ) ) }
			/>
		);
	}

	return TermTokensControl;
}
