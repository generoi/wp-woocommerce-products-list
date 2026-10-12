import { createContext } from '@wordpress/element';

/** Opens the description modal on a description field (quick edit only; null elsewhere). */
export const DescriptionModalContext = createContext< ( ( fieldId: string ) => void ) | null >( null );
