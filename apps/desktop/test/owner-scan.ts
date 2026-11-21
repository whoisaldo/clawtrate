// Finds, in source, collections that can outlive the call that made it: a
// `new Map`, `new Set`, `new WeakMap` or `new WeakSet`, or an array literal,
// written directly as the value of a class field, a module-level variable, or
// a variable a later-running function captures (a closure). A collection a
// factory call makes (`Array.from`, `Array.of`, `Object.fromEntries`) counts as
// one, and so does a collection inside an object literal kept that way, at any
// depth: it is reported under its path (`box.kept`). Collections made and
// dropped within one call are not reported. Strict: a false alarm costs a line
// in the allowlist of `owner-sources.test.ts`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export type Kept = {
  /** `file:Class.field`, `file:name` at module level, or `file:function>name` in a closure. */
  where: string;
  kind: "field" | "module" | "closure";
  file: string;
  owner: string | null;
  name: string;
  line: number;
};

const COLLECTIONS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

/** Factory calls that return a new collection or a new map-like object. */
const FACTORIES = new Set(["Array.from", "Array.of", "Object.fromEntries"]);

function isCollection(node: ts.Node): boolean {
  if (ts.isArrayLiteralExpression(node)) return true;
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression))
    return COLLECTIONS.has(node.expression.text) || node.expression.text === "Array";
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    FACTORIES.has(`${node.expression.expression.text}.${node.expression.name.text}`)
  )
    return true;
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return isCollection(node.expression);
  return false;
}

/**
 * The collections a kept value holds: `""` for the value itself, and for an
 * object literal the dotted path of each collection inside it, at any depth.
 */
function collectionPaths(node: ts.Node): string[] {
  if (isCollection(node)) return [""];
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return collectionPaths(node.expression);
  if (!ts.isObjectLiteralExpression(node)) return [];
  return node.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const key =
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? property.name.text
        : "<computed>";
    return collectionPaths(property.initializer).map((path) => `.${key}${path}`);
  });
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function nameOf(node: ts.Node): string {
  const named = node as { name?: ts.Node };
  return named.name && ts.isIdentifier(named.name) ? named.name.text : "<anonymous>";
}

/** Array methods that call their callback before they return: a callback passed to one does not outlive the call. */
const SYNCHRONOUS = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
  "toSorted",
]);

/** A function passed straight to one of `SYNCHRONOUS`. */
function runsAtOnce(fn: ts.Node): boolean {
  const call = fn.parent;
  return (
    call !== undefined &&
    ts.isCallExpression(call) &&
    call.arguments.includes(fn as ts.Expression) &&
    ts.isPropertyAccessExpression(call.expression) &&
    SYNCHRONOUS.has(call.expression.name.text)
  );
}

/**
 * Whether a function nested inside `scope` (not `scope` itself) that may run
 * after the call refers to `name`: any nested function but one passed
 * straight to a synchronous array method.
 */
function captured(scope: ts.Node, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node, nested: boolean): void => {
    if (found) return;
    if (nested && ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(node, (child) =>
      visit(child, nested || (isFunction(child) && !runsAtOnce(child))),
    );
  };
  ts.forEachChild(scope, (child) => visit(child, isFunction(child) && !runsAtOnce(child)));
  return found;
}

export function scanFile(path: string, root: string): Kept[] {
  return scanText(relative(root, path), readFileSync(path, "utf8"));
}

/** The kept collections of one source text, named as if it were `file`. */
export function scanText(file: string, text: string): Kept[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Kept[] = [];
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node: ts.Node, cls: string | null, fn: ts.Node | null): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      ts.forEachChild(node, (child) =>
        visit(child, nameOf(node), isFunction(child) ? child : null),
      );
      return;
    }
    // A class field initialised with a collection, or with an object holding one.
    if (ts.isPropertyDeclaration(node) && node.initializer) {
      for (const path of collectionPaths(node.initializer)) {
        const name = `${nameOf(node)}${path}`;
        found.push({
          where: `${file}:${cls}.${name}`,
          kind: "field",
          file,
          owner: cls,
          name,
          line: line(node),
        });
      }
    }
    // `this.x = <collection>` assigns a class field.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      for (const path of collectionPaths(node.right)) {
        const name = `${node.left.name.text}${path}`;
        found.push({
          where: `${file}:${cls}.${name}`,
          kind: "field",
          file,
          owner: cls,
          name,
          line: line(node),
        });
      }
    }
    // A variable, at module level or captured by a nested function.
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const variable = node.name.text;
      const keep = fn === null || captured(fn, variable);
      for (const path of keep ? collectionPaths(node.initializer) : []) {
        const name = `${variable}${path}`;
        if (fn === null) {
          found.push({
            where: `${file}:${name}`,
            kind: "module",
            file,
            owner: null,
            name,
            line: line(node),
          });
        } else {
          const owner = nameOf(fn);
          found.push({
            where: `${file}:${owner}>${name}`,
            kind: "closure",
            file,
            owner,
            name,
            line: line(node),
          });
        }
      }
    }
    // A collection assigned later to a variable a nested function captures.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      fn !== null &&
      captured(fn, node.left.text)
    ) {
      for (const path of collectionPaths(node.right)) {
        const name = `${node.left.text}${path}`;
        const owner = nameOf(fn);
        if (!found.some((each) => each.where === `${file}:${owner}>${name}`))
          found.push({
            where: `${file}:${owner}>${name}`,
            kind: "closure",
            file,
            owner,
            name,
            line: line(node),
          });
      }
    }
    ts.forEachChild(node, (child) => visit(child, cls, isFunction(child) ? child : fn));
  };
  visit(source, null, null);
  return found;
}

export function scan(dirs: string[], root: string): Kept[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
    }
  };
  // A file named on its own is scanned as it is.
  for (const dir of dirs) {
    if (statSync(dir).isFile()) files.push(dir);
    else walk(dir);
  }
  return files.sort().flatMap((path) => scanFile(path, root));
}
