import { createContext } from '@wordpress/element';

/** Opens the description modal on a description field (quick edit only; null elsewhere); focus returns to `opener` when it closes. */
export const DescriptionModalContext = createContext< ( ( fieldId: string, opener?: HTMLElement ) => void ) | null >( null );
