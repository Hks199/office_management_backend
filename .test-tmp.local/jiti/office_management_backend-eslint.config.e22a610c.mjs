"use strict";Object.defineProperty(exports, "__esModule", { value: true });exports.default = void 0;var _js = _interopRequireDefault(await jitiImport("@eslint/js"));
var _typescriptEslint = _interopRequireDefault(await jitiImport("typescript-eslint"));
var _config = await jitiImport("eslint/config");function _interopRequireDefault(e) {return e && e.__esModule ? e : { default: e };}var _default = exports.default =

(0, _config.defineConfig)(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  _js.default.configs.recommended,
  _typescriptEslint.default.configs.strictTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: "D:/sunvika/office_management_backend" } } }
); /* v9-c2ebf9ac2db35e37 */
