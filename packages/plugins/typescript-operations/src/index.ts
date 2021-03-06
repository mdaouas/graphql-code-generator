import { PluginFunction, Types } from '@graphql-codegen/plugin-helpers';
import { visit, concatAST, GraphQLSchema } from 'graphql';
import { TypeScriptDocumentsVisitor } from './visitor';
import { RawDocumentsConfig } from '@graphql-codegen/visitor-plugin-common';

export interface TypeScriptDocumentsPluginConfig extends RawDocumentsConfig {
  /**
   * @name avoidOptionals
   * @type boolean
   * @description This will cause the generator to avoid using TypeScript optionals (`?`),
   * so the following definition: `type A { myField: String }` will output `myField: Maybe<string>`
   * instead of `myField?: Maybe<string>`.
   * @default false
   *
   * @example
   * ```yml
   * generates:
   * path/to/file.ts:
   *  plugins:
   *    - typescript
   *    - typescript-operations
   *  config:
   *    avoidOptionals: true
   * ```
   */
  avoidOptionals?: boolean;
  /**
   * @name immutableTypes
   * @type boolean
   * @description Generates immutable types by adding `readonly` to properties and uses `ReadonlyArray`.
   * @default false
   *
   * @example
   * ```yml
   * generates:
   * path/to/file.ts:
   *  plugins:
   *    - typescript
   *    - typescript-operations
   *  config:
   *    immutableTypes: true
   * ```
   */
  immutableTypes?: boolean;
}

export const plugin: PluginFunction<TypeScriptDocumentsPluginConfig> = (schema: GraphQLSchema, documents: Types.DocumentFile[], config: TypeScriptDocumentsPluginConfig) => {
  const allAst = concatAST(
    documents.reduce((prev, v) => {
      return [...prev, v.content];
    }, [])
  );

  const visitorResult = visit(allAst, {
    leave: new TypeScriptDocumentsVisitor(schema, config),
  });

  return visitorResult.definitions.join('\n');
};
