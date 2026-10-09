/**
 * History names every logged action (an extension action's label, never its
 * key such as `i18n_transform`) and searches by product name on both views.
 */
import { describe, expect, it } from 'vitest';
import { batchQueryFromView, describeBatchChanges, describeSkipped } from '../../resources/history/batch-fields';
import { actionLabel, actionOptions, logQueryFromView } from '../../resources/history/log-fields';
import type { DeclarativeAction } from '../../resources/types';
import { editSettings } from './edit-fixtures';

const transform = { id: 'i18n_transform', label: 'Edit translated text' } as DeclarativeAction;
const settings = editSettings( { actions: [ transform ] } );

describe( 'History action names', () => {
	it( 'names an extension action by its label, and a forgotten one in words, never by its key', () => {
		expect( actionLabel( 'i18n_transform', settings ) ).toBe( 'Edit translated text' );
		expect( actionLabel( 'trash', settings ) ).toBe( 'Trash' );
		expect( actionLabel( 'i18n_old_tool', settings ) ).toBe( 'I18n old tool' );
		expect( actionOptions( settings ).map( ( option ) => option.value ) ).toContain( 'i18n_transform' );
		expect( describeBatchChanges( { fields: [], actions: [ 'i18n_transform' ] }, [], settings ) ).toBe( 'Edit translated text' );
	} );
} );

describe( 'History search', () => {
	it( 'sends the search box to /log and /log/batches (the server matches product names)', () => {
		expect( logQueryFromView( { page: 2, perPage: 25, search: ' Collonil ' } ) ).toEqual( { page: 2, per_page: 25, search: 'Collonil' } );
		expect( logQueryFromView( { search: '' } ) ).not.toHaveProperty( 'search' );
		expect( batchQueryFromView( { search: 'Be Lenka' } ) ).toEqual( { page: 1, perPage: 25, search: 'Be Lenka' } );
	} );
} );

describe( 'History batch names', () => {
	it( 'shows the server summary of an action batch and says why items were skipped', () => {
		expect( describeBatchChanges( { fields: [], actions: [ 'duplicate' ], summary: 'Duplicated' }, [], settings ) ).toBe( 'Duplicated' );
		expect( describeBatchChanges( { fields: [], actions: [ 'i18n_transform' ], summary: null }, [], settings ) ).toBe( 'Edit translated text' );
		expect( describeSkipped( { skipped: 5, skipped_reasons: [ 'unchanged' ] } ) ).toBe( '5 skipped (already had the value)' );
		expect( describeSkipped( { skipped: 1 } ) ).toBe( '1 skipped' );
	} );
} );
