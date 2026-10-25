import { createHash } from 'node:crypto';
import ts from 'typescript';

/** Expand DTOs as well as method signatures; file paths and implementation bodies are absent. */
export function persistenceContractShape(checker, rootType) {
  const seen = new Map();
  const nodes = [];
  const builtins = new Set(['Date', 'AbortSignal', 'Buffer', 'Promise', 'Map', 'ReadonlyMap', 'Set', 'ReadonlySet']);
  function shape(type) {
    const name = type.symbol?.getName();
    if (builtins.has(name) && type.symbol.declarations?.every(node => /node_modules[/\\]/u.test(node.getSourceFile().fileName))) {
      return { builtin: name, arguments: checker.getTypeArguments(type).map(shape) };
    }
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return { parameter: checker.typeToString(type), constraint: constraint ? shape(constraint) : null };
    }
    if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Union | ts.TypeFlags.Intersection))) {
      return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
    }
    if (seen.has(type)) return { ref: seen.get(type) };
    const id = nodes.length;
    seen.set(type, id);
    nodes.push(null);
    let node;
    if (type.isUnionOrIntersection()) {
      node = { kind: type.isUnion() ? 'union' : 'intersection', members: [...type.types]
        .sort((a, b) => checker.typeToString(a).localeCompare(checker.typeToString(b), 'en')).map(shape) };
    } else if (checker.isArrayType(type) || checker.isTupleType(type)) {
      node = { kind: checker.isTupleType(type) ? 'tuple' : 'array', readonly: !!type.target?.readonly || name === 'ReadonlyArray',
        elementFlags: type.target?.elementFlags ?? null, arguments: checker.getTypeArguments(type).map(shape) };
    } else {
      node = {
        properties: checker.getPropertiesOfType(type).sort((a, b) => a.name.localeCompare(b.name, 'en')).map(symbol => {
          const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
          if (!declaration) throw new Error(`persistence_contract_property_unresolved:${symbol.name}`);
          return { name: symbol.name, optional: !!(symbol.flags & ts.SymbolFlags.Optional),
            readonly: !!(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly),
            type: shape(checker.getTypeOfSymbolAtLocation(symbol, declaration)) };
        }),
        calls: checker.getSignaturesOfType(type, ts.SignatureKind.Call).map(signature),
        constructs: checker.getSignaturesOfType(type, ts.SignatureKind.Construct).map(signature),
        indexes: checker.getIndexInfosOfType(type).map(index => ({ readonly: index.isReadonly, key: shape(index.keyType), value: shape(index.type) }))
      };
    }
    nodes[id] = node;
    return { ref: id };
  }
  function signature(value) {
    return { thisParameter: value.thisParameter ? shape(checker.getTypeOfSymbolAtLocation(value.thisParameter, value.declaration)) : null,
      parameters: value.parameters.map(symbol => {
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      return { optional: !!(symbol.flags & ts.SymbolFlags.Optional) || !!declaration?.questionToken || !!declaration?.initializer,
        rest: !!declaration?.dotDotDotToken,
        type: shape(checker.getTypeOfSymbolAtLocation(symbol, declaration ?? value.declaration)) };
    }), typeParameters: (value.typeParameters ?? []).map(shape), result: shape(checker.getReturnTypeOfSignature(value)) };
  }
  const root = shape(rootType);
  const graph = { root, nodes };
  return { digest: `sha256:${createHash('sha256').update(JSON.stringify(graph)).digest('hex')}`, graph };
}
