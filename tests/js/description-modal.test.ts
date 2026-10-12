import { describe, expect, it } from 'vitest';
import { withoutGapsBetweenBlocks } from '../../resources/edit/description-modal/description-modal';

describe( 'withoutGapsBetweenBlocks', () => {
	it( 'drops whitespace between block tags only', () => {
		expect( withoutGapsBetweenBlocks( '<h3>Material</h3> <ul> <li>a</li>\n</ul> <hr> <p class="x"><strong>a</strong> <em>b</em></p>' ) ).toBe( '<h3>Material</h3><ul><li>a</li></ul><hr><p class="x"><strong>a</strong> <em>b</em></p>' );
	} );

	it( 'keeps text that sits between tags', () => {
		expect( withoutGapsBetweenBlocks( '<p>a</p> text <p>b</p>' ) ).toBe( '<p>a</p> text <p>b</p>' );
	} );
} );
