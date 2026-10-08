/**
 * The status tabs above the table (All / Published / Drafts / … / Trash)
 * with counts from `/counts`. An ARIA tablist: arrow keys move, Home/End
 * jump, the panel is the table below.
 */
import { useMemo } from '@wordpress/element';
import { applyFilters } from '@wordpress/hooks';
import { __ } from '@wordpress/i18n';
import { FILTERS } from '../extensions/hooks';
import type { Settings } from '../types';
import { STATUS_TAB_IDS } from './default-view';
import type { StatusTabId } from './default-view';

export interface StatusTab {
	id: string;
	label: string;
	count: number | undefined;
}

export function buildStatusTabs( counts: Record< string, number >, settings: Settings ): StatusTab[] {
	const labels = new Map( settings.statuses.map( ( s ) => [ s.value, s.label ] ) );
	const loaded = Object.keys( counts ).length > 0;
	const tabs: StatusTab[] = STATUS_TAB_IDS.map( ( id ) => ( {
		id,
		label: id === 'all' ? __( 'All', 'wp-woocommerce-products-list' ) : labels.get( id ) ?? id,
		count: loaded ? counts[ id ] ?? 0 : undefined,
	} ) ).filter( ( tab ) => tab.id === 'all' || tab.id === 'publish' || ! loaded || ( tab.count ?? 0 ) > 0 );

	return applyFilters( FILTERS.statusTabs, tabs, counts ) as StatusTab[];
}

export interface StatusTabsProps {
	tab: StatusTabId;
	onChange: ( tab: StatusTabId ) => void;
	counts: Record< string, number >;
	settings: Settings;
	panelId?: string;
}

export function StatusTabs( { tab, onChange, counts, settings, panelId = 'wc-products-list-panel' }: StatusTabsProps ) {
	const tabs = useMemo( () => buildStatusTabs( counts, settings ), [ counts, settings ] );
	const current = tabs.some( ( t ) => t.id === tab ) ? tab : 'all';

	const onKeyDown = ( event: React.KeyboardEvent< HTMLDivElement > ) => {
		const index = tabs.findIndex( ( t ) => t.id === current );
		let next = index;

		switch ( event.key ) {
			case 'ArrowRight':
				next = ( index + 1 ) % tabs.length;
				break;
			case 'ArrowLeft':
				next = ( index - 1 + tabs.length ) % tabs.length;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = tabs.length - 1;
				break;
			default:
				return;
		}

		event.preventDefault();
		const target = tabs[ next ];

		if ( target ) {
			onChange( target.id as StatusTabId );
			( event.currentTarget.querySelector( `[data-tab="${ target.id }"]` ) as HTMLElement | null )?.focus();
		}
	};

	return (
		<div className="wc-products-list__tabs" role="tablist" aria-label={ __( 'Product status', 'wp-woocommerce-products-list' ) } onKeyDown={ onKeyDown }>
			{ tabs.map( ( t ) => {
				const selected = t.id === current;

				return (
					<button
						key={ t.id }
						type="button"
						role="tab"
						data-tab={ t.id }
						id={ `wc-products-list-tab-${ t.id }` }
						aria-selected={ selected }
						aria-controls={ panelId }
						tabIndex={ selected ? 0 : -1 }
						className={ `wc-products-list__tab${ selected ? ' is-active' : '' }${ t.id === 'trash' ? ' is-trash' : '' }` }
						onClick={ () => onChange( t.id as StatusTabId ) }
					>
						<span className="wc-products-list__tab-label">{ t.label }</span>
						{ t.count !== undefined && <span className="wc-products-list__tab-count">{ t.count.toLocaleString() }</span> }
					</button>
				);
			} ) }
		</div>
	);
}
