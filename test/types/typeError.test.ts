import { expect } from 'chai';
import { describe, it } from 'mocha';

import { TypeError } from '../../lib/types/typeError.js';

describe('TypeError', () => {
  it('should be an instance of Error', () => {
    const error = new TypeError('test error message');
    expect(error).to.be.an.instanceof(Error);
  });

  it('should store the error message', () => {
    const message = 'test type error message';
    const error = new TypeError(message);
    expect(error.message).to.equal(message);
  });
});
