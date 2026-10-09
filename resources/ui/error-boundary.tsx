/**
 * Small error boundaries so one failure (a lazy chunk that did not load, an
 * extension renderer that throws) stays where it happened instead of
 * unmounting the whole Catalog through createRoot.
 */
import { Button, Notice } from '@wordpress/components';
import { Component, createElement } from '@wordpress/element';
import type { ComponentType, ReactNode } from 'react';
import { __ } from '@wordpress/i18n';

/** A webpack chunk that failed to load (network error, timeout, or a plugin update since page load). */
export function isChunkLoadError( error: unknown ): boolean {
	if ( ! ( error instanceof Error ) ) {
		return false;
	}

	return error.name === 'ChunkLoadError' || /Loading (CSS )?chunk [\w-]+ failed/i.test( error.message );
}

interface BoundaryProps {
	children?: ReactNode;
	/** Where it failed, for the console ("editor", "history", "table", "cell price"). */
	context: string;
	/** What the user sees when it fails; defaults to an inline error with Retry or Reload. */
	fallback?: ( props: { error: Error; retry: () => void; isChunkError: boolean } ) => ReactNode;
	/** Called on Retry, after the boundary resets. */
	onRetry?: () => void;
}

interface BoundaryState {
	error: Error | null;
}

export class ErrorBoundary extends Component< BoundaryProps, BoundaryState > {
	override state: BoundaryState = { error: null };

	static getDerivedStateFromError( error: unknown ): BoundaryState {
		return { error: error instanceof Error ? error : new Error( String( error ) ) };
	}

	override componentDidCatch( error: unknown ): void {
		 
		console.error( `[wc-products-list] ${ this.props.context }`, error );
	}

	retry = (): void => {
		this.setState( { error: null } );
		this.props.onRetry?.();
	};

	override render(): ReactNode {
		const { error } = this.state;

		if ( ! error ) {
			return this.props.children ?? null;
		}

		const isChunkError = isChunkLoadError( error );

		if ( this.props.fallback ) {
			return this.props.fallback( { error, retry: this.retry, isChunkError } );
		}

		return (
			<Notice status="error" isDismissible={ false } className="wc-products-list__boundary">
				{ isChunkError
					? __( 'Part of the Catalog could not be loaded. The plugin may have been updated, or the connection dropped.', 'wp-woocommerce-products-list' )
					: __( 'Something went wrong while showing this part of the Catalog.', 'wp-woocommerce-products-list' ) }{ ' ' }
				{ isChunkError ? (
					<Button variant="link" onClick={ () => window.location.reload() }>
						{ __( 'Reload the page', 'wp-woocommerce-products-list' ) }
					</Button>
				) : (
					<Button variant="link" onClick={ this.retry }>
						{ __( 'Try again', 'wp-woocommerce-products-list' ) }
					</Button>
				) }
			</Notice>
		);
	}
}

/** The fallback of one table cell: a muted dash with the reason as its title. */
function CellFallback() {
	return (
		<span className="wc-products-list-field wc-products-list-field--error" title={ __( 'This value could not be shown.', 'wp-woocommerce-products-list' ) }>
			{ '—' }
		</span>
	);
}

const guarded = new WeakMap< ComponentType< any >, ComponentType< any > >(); // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Wrap a field's cell renderer so a throw shows a dash in that cell only.
 * Memoised per renderer, so React sees a stable component type.
 */
export function guardCell< P extends object >( render: ComponentType< P >, context: string ): ComponentType< P > {
	const existing = guarded.get( render );

	if ( existing ) {
		return existing as ComponentType< P >;
	}

	function GuardedCell( props: P ) {
		return (
			<ErrorBoundary context={ context } fallback={ () => <CellFallback /> }>
				{ createElement( render, props ) }
			</ErrorBoundary>
		);
	}

	GuardedCell.displayName = `GuardedCell(${ context })`;
	guarded.set( render, GuardedCell );

	return GuardedCell;
}
