import {
  SelectionSetNode,
  Kind,
  FieldNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  GraphQLNamedType,
  isObjectType,
  isUnionType,
  isInterfaceType,
  isEnumType,
  GraphQLSchema,
  isEqualType,
  GraphQLField,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  isScalarType
} from 'graphql';
import { getBaseType, quoteIfNeeded } from './utils';
import { ScalarsMap, ConvertNameFn } from './types';
import { GraphQLObjectType, GraphQLNonNull, GraphQLList } from 'graphql';
import { BaseVisitorConvertOptions } from './base-visitor';

export type PrimitiveField = string;
export type PrimitiveAliasedFields = { alias: string; fieldName: string };
export type LinkField = { alias: string; name: string; type: string; selectionSet: string };
export type FragmentSpreadField = string;
export type InlineFragmentField = { [onType: string]: string[] };

function isMetadataFieldName(name: string) {
  return ['__schema', '__type'].includes(name);
}

function isRootType(type: GraphQLNamedType, schema: GraphQLSchema): type is GraphQLObjectType {
  return (
    isEqualType(type, schema.getQueryType()) ||
    isEqualType(type, schema.getMutationType()) ||
    isEqualType(type, schema.getSubscriptionType())
  );
}

const metadataFieldMap: Record<string, GraphQLField<any, any>> = {
  __schema: SchemaMetaFieldDef,
  __type: TypeMetaFieldDef
};

export class SelectionSetToObject {
  protected _primitiveFields: PrimitiveField[] = [];
  protected _primitiveAliasedFields: PrimitiveAliasedFields[] = [];
  protected _linksFields: LinkField[] = [];
  protected _fragmentSpreads: FragmentSpreadField[] = [];
  protected _inlineFragments: InlineFragmentField = {};
  protected _queriedForTypename = false;

  constructor(
    protected _scalars: ScalarsMap,
    protected _schema: GraphQLSchema,
    protected _convertName: ConvertNameFn<BaseVisitorConvertOptions>,
    protected _addTypename: boolean,
    protected _parentSchemaType?: GraphQLNamedType,
    protected _selectionSet?: SelectionSetNode
  ) {}

  public createNext(parentSchemaType: GraphQLNamedType, selectionSet: SelectionSetNode): SelectionSetToObject {
    throw new Error(`You must override createNext in your SelectionSetToObject implementation!`);
  }

  protected wrapTypeWithModifiers(
    baseType: string,
    type: GraphQLObjectType | GraphQLNonNull<GraphQLObjectType> | GraphQLList<GraphQLObjectType>
  ): string {
    throw new Error(`You must override wrapTypeWithModifiers in your SelectionSetToObject implementation!`);
  }

  _collectField(field: FieldNode) {
    if (field.name.value === '__typename') {
      this._queriedForTypename = true;

      return;
    }

    if (isObjectType(this._parentSchemaType) || isInterfaceType(this._parentSchemaType)) {
      let schemaField: GraphQLField<any, any>;

      if (isRootType(this._parentSchemaType, this._schema) && isMetadataFieldName(field.name.value)) {
        schemaField = metadataFieldMap[field.name.value];
      } else {
        schemaField = this._parentSchemaType.getFields()[field.name.value];
      }

      const rawType = schemaField.type as any;
      const baseType = getBaseType(rawType);
      const typeName = baseType.name;

      if (this._scalars[typeName] || isEnumType(baseType) || isScalarType(baseType)) {
        if (field.alias && field.alias.value) {
          this._primitiveAliasedFields.push({
            fieldName: field.name.value,
            alias: field.alias.value
          });
        } else {
          this._primitiveFields.push(field.name.value);
        }
      } else {
        const selectionSetToObject = this.createNext(baseType, field.selectionSet);

        this._linksFields.push({
          alias: field.alias ? field.alias.value : null,
          name: field.name.value,
          type: typeName,
          selectionSet: this.wrapTypeWithModifiers(selectionSetToObject.string, rawType)
        });
      }
    }
  }

  _collectFragmentSpread(node: FragmentSpreadNode) {
    this._fragmentSpreads.push(node.name.value);
  }

  _collectInlineFragment(node: InlineFragmentNode) {
    const onType = node.typeCondition.name.value;
    const schemaType = this._schema.getType(onType);
    const selectionSet = this.createNext(schemaType, node.selectionSet);

    if (!this._inlineFragments[onType]) {
      this._inlineFragments[onType] = [];
    }

    this._inlineFragments[onType].push(selectionSet.string);
  }

  get string(): string {
    if (!this._selectionSet || !this._selectionSet.selections || this._selectionSet.selections.length === 0) {
      return '';
    }

    const { selections } = this._selectionSet;

    for (const selection of selections) {
      switch (selection.kind) {
        case Kind.FIELD:
          this._collectField(selection as FieldNode);
          break;
        case Kind.FRAGMENT_SPREAD:
          this._collectFragmentSpread(selection as FragmentSpreadNode);
          break;
        case Kind.INLINE_FRAGMENT:
          this._collectInlineFragment(selection as InlineFragmentNode);
          break;
      }
    }

    const parentName = this._convertName(this._parentSchemaType.name, {
      useTypesPrefix: true
    });
    const typeName = this._addTypename || this._queriedForTypename ? this.buildTypeNameField() : null;
    const baseFields = this.buildPrimitiveFields(parentName, this._primitiveFields);
    const aliasBaseFields = this.buildAliasedPrimitiveFields(parentName, this._primitiveAliasedFields);
    const linksFields = this.buildLinkFields(this._linksFields);
    const inlineFragments = this.buildInlineFragments(this._inlineFragments);
    const fragmentSpreads = this.buildFragmentSpread(this._fragmentSpreads);
    const fieldsSet = [typeName, baseFields, aliasBaseFields, linksFields, fragmentSpreads, inlineFragments].filter(
      f => f && f !== ''
    );

    return this.mergeAllFields(fieldsSet);
  }

  protected mergeAllFields(fieldsSet: Array<string | null>): string {
    return quoteIfNeeded(fieldsSet, ' & ');
  }

  protected buildTypeNameField(): string | null {
    const possibleTypes = [];

    if (!isUnionType(this._parentSchemaType) && !isInterfaceType(this._parentSchemaType)) {
      possibleTypes.push(this._parentSchemaType.name);
    }

    if (possibleTypes.length === 0) {
      return null;
    }

    return `{ ${this.formatNamedField('__typename')}${this._queriedForTypename ? '' : '?'}: ${possibleTypes
      .map(t => `'${t}'`)
      .join(' | ')} }`;
  }

  protected buildPrimitiveFields(parentName: string, fields: PrimitiveField[]): string | null {
    if (fields.length === 0) {
      return null;
    }

    return `Pick<${parentName}, ${fields.map(field => `'${field}'`).join(' | ')}>`;
  }

  protected buildAliasedPrimitiveFields(parentName: string, fields: PrimitiveAliasedFields[]): string | null {
    if (fields.length === 0) {
      return null;
    }

    return `{ ${fields
      .map(aliasedField => `${this.formatNamedField(aliasedField.alias)}: ${parentName}['${aliasedField.fieldName}']`)
      .join(', ')} }`;
  }

  protected formatNamedField(name: string): string {
    return name;
  }

  protected buildLinkFields(fields: LinkField[]): string | null {
    if (fields.length === 0) {
      return null;
    }

    return `{ ${fields
      .map(field => `${this.formatNamedField(field.alias || field.name)}: ${field.selectionSet}`)
      .join(', ')} }`;
  }

  protected buildInlineFragments(inlineFragments: InlineFragmentField): string | null {
    const allPossibleTypes = Object.keys(inlineFragments).map(typeName => inlineFragments[typeName].join(' & '));

    return allPossibleTypes.length === 0 ? null : `(${allPossibleTypes.join(' | ')})`;
  }

  protected buildFragmentSpread(fragmentsSpread: FragmentSpreadField[]): string | null {
    if (fragmentsSpread.length === 0) {
      return null;
    }

    return quoteIfNeeded(
      fragmentsSpread.map(fragmentName =>
        this._convertName(fragmentName, {
          suffix: 'Fragment',
          useTypesPrefix: true
        })
      ),
      ' & '
    );
  }
}
