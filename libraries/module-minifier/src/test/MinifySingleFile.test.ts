import { minifySingleFileAsync } from '../MinifySingleFile';

describe(minifySingleFileAsync.name, () => {
  it('uses consistent identifiers for webpack vars', async () => {
    const code: string = `__MINIFY_MODULE__(function (module, __webpack_exports__, __webpack_require__) {});`;

    const minifierResult = await minifySingleFileAsync(
      {
        hash: 'foo',
        code,
        nameForMap: undefined,
        externals: undefined
      },
      {
        mangle: true
      }
    );

    expect(minifierResult).toMatchSnapshot();
  });
});
