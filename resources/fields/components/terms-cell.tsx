import { decodeEntities } from '@wordpress/html-entities';
import type { RawTerm } from '../../types';

/** A taxonomy column: term names, comma separated. */
export function TermsCell( { terms }: { terms: RawTerm[] | undefined } ) {
	if ( ! terms?.length ) {
		return <span className="wc-products-list__terms wc-products-list__terms--empty">—</span>;
	}

	return <span className="wc-products-list__terms">{ terms.map( ( term ) => decodeEntities( term.name ) ).join( ', ' ) }</span>;
}
