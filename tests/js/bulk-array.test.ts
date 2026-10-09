import { describe, expect, it } from 'vitest';
import { applyArrayOp, arrayOpFieldId, hasArrayOp, isArrayOpFieldId, withArrayOps } from '../../resources/edit/bulk-array';
import { projectEdits } from '../../resources/edit/bulk-numeric';
import { describeEdits } from '../../resources/edit/change-summary';
import { toFormFields } from '../../resources/edit/form-fields';
import { mergeItems } from '../../resources/edit/merge';
import { buildPayload } from '../../resources/edit/payload';
import { planSave } from '../../resources/edit/save-runner';
import { visibleEditFields } from '../../resources/edit/visibility';
import type { ProductField } from '../../resources/types';
import { coreFields, editSettings, field, simple } from './edit-fixtures';

const settings = editSettings();

const categories: ProductField = field( 'categories', {
	type: 'array',
	label: 'Categories',
	getElements: async () => [ { value: 15 as unknown as string, label: 'Uncategorized' }, { value: 83 as unknown as string, label: 'Boots' }, { value: 94 as unknown as string, label: 'Sale' } ],
	getValue: ( { item } ) => ( ( item as { categories?: Array< { id: number } > } ).categories ?? [] ).map( ( term ) => term.id ) as unknown as string[],
	rest: { fields: [ 'categories' ], write: ( value ) => ( { categories: ( value as unknown[] ).map( ( id ) => ( { id: Number( id ) } ) ) } ), applies: { product: true, variation: false } },
	edit: { group: 'organization', bulk: 'default', order: 40 },
} );
const fields = withArrayOps( [ ...coreFields().filter( ( entry ) => entry.id !== 'categories' ), categories ] );
const boots = simple( 1, { categories: [ { id: 15, name: 'Uncategorized' }, { id: 83, name: 'Boots' } ] } );
const sale = simple( 2, { categories: [ { id: 94, name: 'Sale' } ] } );
const bare = simple( 3, { categories: [] } );

describe( 'withArrayOps', () => {
	it( 'puts an add/remove/replace select in front of every bulk-editable list field, once', () => {
		const ids = fields.map( ( entry ) => entry.id );
		const opId = arrayOpFieldId( 'categories' );

		expect( ids.indexOf( opId ) ).toBe( ids.indexOf( 'categories' ) - 1 );
		expect( isArrayOpFieldId( opId ) ).toBe( true );
		expect( hasArrayOp( fields, 'categories' ) ).toBe( true );
		expect( hasArrayOp( coreFields(), 'categories' ) ).toBe( false );
		expect( withArrayOps( fields ).filter( ( entry ) => entry.id === opId ) ).toHaveLength( 1 );

		const op = fields.find( ( entry ) => entry.id === opId )!;

		expect( op.elements?.map( ( element ) => element.value ) ).toEqual( [ 'add', 'remove', 'replace' ] );
		expect( op.edit ).toMatchObject( { group: 'organization', order: 39.5 } );
		expect( op.rest.read?.( boots ) ).toBe( 'add' );
		// Shown in bulk like the list field itself.
		expect( visibleEditFields( fields, [ boots, sale ], { mode: 'bulk', applyToVariations: false } ).map( ( entry ) => entry.id ) ).toContain( opId );
	} );

	it( 'the list field starts empty in the form so the picked terms are the delta, and the op is no edit until changed', () => {
		const merged = mergeItems( [ boots, boots ], fields );

		expect( merged.data.categories ).toEqual( [] );
		expect( merged.data[ arrayOpFieldId( 'categories' ) ] ).toBe( 'add' );
		expect( mergeItems( [ boots ], [ categories ] ).data.categories ).toEqual( [ 15, 83 ] );

		const form = toFormFields( fields, { bulk: true, items: [ boots, sale ], base: merged.data, mixed: merged.mixed, settings } );

		expect( form.find( ( entry ) => entry.id === arrayOpFieldId( 'categories' ) )?.elements ).toHaveLength( 3 );
	} );
} );

describe( 'applyArrayOp', () => {
	it( 'adds, removes and replaces against the row’s own list and says whether anything changed', () => {
		expect( applyArrayOp( [ 15, 83 ], 'add', [ 94 ] ) ).toEqual( { next: [ 15, 83, 94 ], changed: true } );
		expect( applyArrayOp( [ 15, 83 ], 'add', [ 83 ] ) ).toEqual( { next: [ 15, 83 ], changed: false } );
		expect( applyArrayOp( [ 15, 83 ], 'remove', [ 83 ] ) ).toEqual( { next: [ 15 ], changed: true } );
		expect( applyArrayOp( [ 15, 83 ], 'remove', [ 94 ] ) ).toEqual( { next: [ 15, 83 ], changed: false } );
		expect( applyArrayOp( [ 15, 83 ], 'replace', [ 83, 15 ] ) ).toEqual( { next: [ 83, 15 ], changed: false } );
		expect( applyArrayOp( [ 15, 83 ], 'replace', [ 94 ] ) ).toEqual( { next: [ 94 ], changed: true } );
		// Ids compare as strings, and term objects by their id.
		expect( applyArrayOp( [ { id: 15 } ], 'add', [ '15' ] ).changed ).toBe( false );
		expect( applyArrayOp( undefined, 'add', [ 1 ] ) ).toEqual( { next: [ 1 ], changed: true } );
	} );
} );

describe( 'bulk list edits per row', () => {
	it( 'adding a category keeps what each row has (classic bulk edit appends)', () => {
		const edits = { categories: [ 94 ] };

		expect( projectEdits( boots, edits, fields, settings ) ).toEqual( { categories: [ 15, 83, 94 ] } );
		expect( projectEdits( sale, edits, fields, settings ) ).toEqual( {} );
		expect( buildPayload( boots, edits, fields, settings ) ).toEqual( { categories: [ { id: 15 }, { id: 83 }, { id: 94 } ] } );
		expect( buildPayload( sale, edits, fields, settings ) ).toEqual( {} );
	} );

	it( 'removing and replacing follow the op field; the op itself never reaches the payload', () => {
		const opId = arrayOpFieldId( 'categories' );

		expect( buildPayload( boots, { categories: [ 83 ], [ opId ]: 'remove' }, fields, settings ) ).toEqual( { categories: [ { id: 15 } ] } );
		expect( buildPayload( boots, { categories: [ 94 ], [ opId ]: 'replace' }, fields, settings ) ).toEqual( { categories: [ { id: 94 } ] } );
		expect( buildPayload( boots, { [ opId ]: 'replace' }, fields, settings ) ).toEqual( {} );
		// "Replace all with" nothing never empties the rows' lists (categories would become Uncategorized).
		expect( buildPayload( boots, { categories: [], [ opId ]: 'replace' }, fields, settings ) ).toEqual( {} );
		expect( describeEdits( { categories: [], [ opId ]: 'replace' }, fields, [ boots ], settings ) ).toEqual( [] );
	} );

	it( 'without an op field (quick edit) the list is the full list, as before', () => {
		expect( buildPayload( boots, { categories: [ 94 ] }, [ categories ], settings ) ).toEqual( { categories: [ { id: 94 } ] } );
	} );

	it( 'the summary names the operation and counts only the rows that change', () => {
		const lines = describeEdits( { categories: [ 94 ] }, fields, [ boots, sale, bare ], settings );

		expect( lines ).toHaveLength( 1 );
		expect( lines[ 0 ] ).toMatchObject( { field: 'categories', change: 'add 94', count: 2 } );
		expect( describeEdits( { categories: [ 83 ], [ arrayOpFieldId( 'categories' ) ]: 'remove' }, fields, [ boots, sale, bare ], settings )[ 0 ] ).toMatchObject( { change: 'remove 83', count: 1 } );
	} );

	it( 'the plan writes only the rows whose list changes', () => {
		const plan = planSave( [ boots, sale, bare ], { categories: [ 94 ] }, fields, settings, { applyToVariations: false } );

		expect( plan.writes.map( ( entry ) => entry.target.item.id ) ).toEqual( [ 1, 3 ] );
		expect( plan.unchanged ).toBe( 1 );
	} );
} );
