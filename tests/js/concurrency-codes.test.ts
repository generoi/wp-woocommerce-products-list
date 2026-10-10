/**
 * The client side of the server's concurrency refusals (docs/contracts.md
 * §3.6): readable messages, which codes the server already logged, which
 * mean the row is gone.
 */
import { describe, expect, it } from 'vitest';
import { actionResultMessage, humanizeError, isGoneCode, isServerLoggedCode, isServerLoggedItemError } from '../../resources/edit/errors';
import { summarize } from '../../resources/actions/context';
import { skipReasonLabel } from '../../resources/history/batch-scope';

describe( 'wc_products_list_deleted', () => {
	it( 'reads as deleted meanwhile, is already logged by the server, and drops the row', () => {
		expect( humanizeError( 'wc_products_list_deleted', 'Gone.' ) ).toBe( 'Deleted meanwhile (another tab or user); nothing was saved for this item.' );
		expect( isServerLoggedCode( 'wc_products_list_deleted' ) ).toBe( true );
		expect( isGoneCode( 'wc_products_list_deleted' ) ).toBe( true );
	} );

	it( 'takes a wc/v3 invalid id of a batch answer as logged by the server (once, as deleted), not posted again', () => {
		expect( isServerLoggedCode( 'woocommerce_rest_product_invalid_id' ) ).toBe( false );
		expect( isGoneCode( 'woocommerce_rest_product_invalid_id' ) ).toBe( true );
		expect( isServerLoggedItemError( 'woocommerce_rest_product_variation_invalid_id', { status: 404 } ) ).toBe( true );
		expect( isServerLoggedItemError( 'woocommerce_rest_product_invalid_id', undefined ) ).toBe( true );
		// A row of a request that failed as a whole was never answered by the server: the client logs it.
		expect( isServerLoggedItemError( 'woocommerce_rest_product_invalid_id', { wcpl_request_failed: true } ) ).toBe( false );
	} );
} );

describe( 'wc_products_list_editing', () => {
	it( 'shows the server message naming the user, is already logged by the server, and keeps the row', () => {
		expect( humanizeError( 'wc_products_list_editing', 'Anna is editing this product in the product editor.' ) ).toBe( 'Anna is editing this product in the product editor.' );
		expect( humanizeError( 'wc_products_list_editing', '' ) ).toMatch( /^This product is open in the product editor/ );
		expect( isServerLoggedCode( 'wc_products_list_editing' ) ).toBe( true );
		expect( isGoneCode( 'wc_products_list_editing' ) ).toBe( false );
	} );

	it( 'labels the editing and locked skip reasons in History', () => {
		expect( skipReasonLabel( 'editing' ) ).toBe( 'open in the product editor' );
		expect( skipReasonLabel( 'locked' ) ).toBe( 'another save was running' );
	} );
} );

describe( 'row action results', () => {
	it( 'shows a locked id like the save\'s locked message, other failures as sent', () => {
		expect( actionResultMessage( 'wc_products_list_locked', 'Locked.' ) ).toMatch( /^Another save of this item was still running/ );
		expect( actionResultMessage( 'not_found', 'Not found.' ) ).toBe( 'Not found.' );
		expect( actionResultMessage( undefined, undefined ) ).toBe( 'The action failed.' );
	} );

	it( 'summarize() uses it', () => {
		const { ok, failed } = summarize( {
			results: [
				{ id: 1, ok: true },
				{ id: 2, ok: false, code: 'wc_products_list_locked', message: 'Locked.' },
			],
		} as never );

		expect( ok ).toEqual( [ 1 ] );
		expect( failed[ 0 ]?.message ).toMatch( /Try again in a moment/ );
	} );
} );
