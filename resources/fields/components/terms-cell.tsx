import { decodeEntities } from '@wordpress/html-entities';
import type { RawTerm } from '../../types';

/** A taxonomy column: term names, comma separated, truncated to the column (the full list is the tooltip). */
export function TermsCell( { terms }: { terms: RawTerm[] | undefined } ) {
	if ( ! terms?.length ) {
		return <span className="wc-products-list__terms wc-products-list__terms--empty">—</span>;
	}

	const text = terms.map( ( term ) => decodeEntities( term.name ) ).join( ', ' );

	return (
		<span className="wc-products-list__terms" title={ terms.length > 1 ? text : undefined }>
			{ text }
		</span>
	);
}
