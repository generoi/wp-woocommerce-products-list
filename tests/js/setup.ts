import { beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';


// The editor remembers the last tab across editors in sessionStorage; every test starts fresh.
beforeEach( () => {
	window.sessionStorage.removeItem( 'wcProductsList.editorTab' );
} );
