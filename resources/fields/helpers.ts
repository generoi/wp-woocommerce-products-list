/**
 * Defaults for core field definitions so each field file states only what
 * differs: `rest.fields` is the id, the key exists on products only, every
 * product type, quick-editable in the "general" group.
 */
import type { Option, ProductField, ProductListItem } from '../types';

type RestOverrides = Partial< ProductField[ 'rest' ] > & { applies?: Partial< ProductField[ 'rest' ][ 'applies' ] > };

export type FieldSpec = Omit< ProductField, 'rest' | 'productTypes' | 'edit' | 'source' > & {
	rest?: RestOverrides;
	productTypes?: ProductField[ 'productTypes' ];
	edit?: ProductField[ 'edit' ];
};

export function field( spec: FieldSpec ): ProductField {
	const { rest, productTypes, edit, ...rest_ } = spec;

	return {
		...rest_,
		rest: {
			fields: rest?.fields ?? [ spec.id ],
			read: rest?.read,
			write: rest?.write,
			param: rest?.param,
			sortParam: rest?.sortParam,
			applies: { product: rest?.applies?.product ?? true, variation: rest?.applies?.variation ?? false },
		},
		productTypes: productTypes ?? 'all',
		edit: edit === undefined ? { group: 'general', bulk: 'default' } : edit,
		source: 'core',
	};
}

/** `{value,label}` lists from the settings payload are already DataViews elements. */
export function elements( options: Option[] ): Option[] {
	return options;
}

export function valueOf( item: ProductListItem, key: string ): unknown {
	return ( item as Record< string, unknown > )[ key ];
}

/** The product types that sell on their own (not variable, not grouped). */
export const SELLABLE_TYPES = [ 'simple', 'external' ] as const;

/** Types that carry stock and shipping data. */
export const PHYSICAL_TYPES = [ 'simple', 'variable' ] as const;
