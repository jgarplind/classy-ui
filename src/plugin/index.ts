import { writeFileSync } from 'fs';
import { join } from 'path';

import { config as baseConfig } from '../config/base.config';
import { transform as transformClassesToTypes } from '../config/transform-classes-to-types';
import { transform as transformConfigToClasses } from '../config/transform-config-to-classes';
import { IExtractedClass, IExtractedClasses } from '../types';
import { createClassObject, getUserConfig, injectDevelopment, injectProduction, mergeConfigs } from '../utils';

const cssPath = join(process.cwd(), 'node_modules', 'classy-ui', 'styles.css');
const config = mergeConfigs(baseConfig, getUserConfig());
const classes = transformConfigToClasses(config);

if (process.env.NODE_ENV !== 'test') {
  const esTypesPath = join(process.cwd(), 'node_modules', 'classy-ui', 'es', 'classy-ui.d.ts');
  const libTypesPath = join(process.cwd(), 'node_modules', 'classy-ui', 'lib', 'classy-ui.d.ts');
  const types = transformClassesToTypes(classes.defaults, config);

  writeFileSync(esTypesPath, types);
  writeFileSync(libTypesPath, types);
}

export default (babel: any) => {
  return {
    name: 'classy-ui/plugin',
    visitor: {
      Program(programmPath: any, state: any) {
        programmPath.traverse({
          ImportDeclaration(path: any) {
            if (path?.node?.source?.value === 'classy-ui') {
              const imports = path.node.specifiers.map((s: any) => s.local.name);

              const referencePaths = imports.reduce((aggr: any[], localName: string) => {
                const binding = path.scope.getBinding(localName);
                if (binding && Boolean(binding.referencePaths.length)) {
                  aggr = aggr.concat(binding.referencePaths);
                }
                return aggr;
              }, []);

              if (Boolean(referencePaths.length)) {
                processReferences(babel, state, referencePaths);
              }
            }
          },
        });
      },
    },
  };
};

export function processReferences(babel: any, state: any, classnamesRefs: any) {
  const { types: t } = babel;

  const isProduction = babel.getEnv() === 'production';

  const classCollection: IExtractedClasses = {};

  function collectAndRewrite(classObj: IExtractedClass, transformer?: (name: string) => any): any[] {
    if (classObj.uid && classObj.id) {
      classCollection[classObj.uid] = classObj;
    }
    return classObj.name ? (transformer ? [transformer(classObj.name)] : classObj.name.split(' ')) : [];
  }

  function convertToExpression(classAttribs: Set<any>) {
    const strings = [];
    const others = [];
    for (const item of classAttribs.values()) {
      if (typeof item === 'string') {
        if (item.length !== 0) {
          strings.push(item);
        }
      } else {
        others.push(item);
      }
    }

    if (strings.length > 0 && others.length > 0) {
      others.unshift(t.stringLiteral(`${strings.join(' ')} `));
    } else if (strings.length > 0) {
      return t.stringLiteral(strings.join(' '));
    }

    if (others.length > 0) {
      const max = others.length - 1;
      let start = others[max];
      for (let i = max - 1; i >= 0; i--) {
        start = t.binaryExpression('+', others[i], start);
      }
      return start;
    }

    // We can't safely remove the whole expression
    // becasue in JSX you need to have an actual argument
    return t.stringLiteral('');
  }

  function updateContext(decorators: string[], value: string) {
    const newDecorators = decorators.slice();
    newDecorators.push(value);
    return newDecorators;
  }

  function getImportName(name: string, scope: any) {
    const binding = scope.getBinding(name);
    if (binding && t.isImportSpecifier(binding.path.node) && binding.path.parent.source.value.startsWith('classy-ui')) {
      return binding.path.node.imported.name;
    }
    return null;
  }

  function throwCodeFragmentIfInvalidId(path: any, id: string) {
    if (!classes.defaults[id] && !classes.themes[id]) {
      throw path.buildCodeFrameError(`Could not find class ${id}`);
    }
  }
  function throwIfForbiddenName(path: any, decorators: string[], name: string) {
    if (decorators.includes(name)) {
      throw path.buildCodeFrameError(`Duplicating ${name} is not allowed.`);
    }
  }

  function getIdOrThrow(path: any) {
    if (t.isStringLiteral(path.node)) {
      return path.node.value;
    } else if (t.isIdentifier(path.node)) {
      return path.node.name;
    } else {
      throw path.buildCodeFrameError(`This property is not supported`);
    }
  }

  function rewriteAndCollectArguments(decorators: any, argumentPaths: any, classArgs: Set<any>) {
    // if root call has no arguments
    if (argumentPaths.length === 0) {
      const classObj = createClassObject(undefined, decorators);
      collectAndRewrite(classObj).forEach(classArgs.add, classArgs);
    }
    // process arguments
    argumentPaths.forEach((argPath: any) => {
      const node = argPath.node;

      if (t.isStringLiteral(node)) {
        const id = node.value;
        throwCodeFragmentIfInvalidId(argPath, id);
        const classObj = createClassObject(node.value, decorators);
        collectAndRewrite(classObj).forEach(classArgs.add, classArgs);
        return;
      } else if (t.isIdentifier(node)) {
        // This is the only knowlage the plugin has
        // about the imports from classy-ui
        if (decorators[0] !== 'c') {
          throw argPath.buildCodeFrameError(`Composing variabels is only allowed with c()`);
        }
        classArgs.add(node);
        return;
      } else if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
        // To support import { hover as ho }...
        const name = getImportName(node.callee.name, argPath.scope);
        // When not found it is not part of classy ui
        if (name != null) {
          throwIfForbiddenName(argPath, decorators, name);
          const newDecorators = updateContext(decorators, name);
          const childArguments = argPath.get('arguments');
          if (Boolean(childArguments.length)) {
            rewriteAndCollectArguments(newDecorators, childArguments, classArgs);
            return;
          } else {
            // if subsequent calls have no arguments
            const classObj = createClassObject(undefined, newDecorators);
            collectAndRewrite(classObj).forEach(classArgs.add, classArgs);
            return;
          }
        } else {
          throw argPath.buildCodeFrameError(`Composing variabels is only allowed with classnames()`);
        }
      } else if (t.isObjectExpression(node)) {
        argPath.get('properties').forEach((propPath: any) => {
          const id = getIdOrThrow(propPath.get('key'));
          const classObj = createClassObject(id, decorators);
          throwCodeFragmentIfInvalidId(propPath, id);

          collectAndRewrite(classObj, name => {
            return t.conditionalExpression(propPath.node.value, t.stringLiteral(name), t.stringLiteral(''));
          }).forEach(classArgs.add, classArgs);
        });
        return;
      }
      classArgs.add(node);
      return classArgs;
    }, new Set());
  }

  classnamesRefs
    // Only use top-most class
    .filter((path: any) => {
      // path.node will always be an identifier
      // if path.parentPath.parent is a CallExpression
      // it's callee name must not be part of classy-ui to be allowed here

      if (t.isCallExpression(path.parentPath.parent)) {
        return getImportName(path.parentPath.parent.callee.name, path.scope) === null;
      }
      return true;
    })
    .forEach((path: any) => {
      const statementPath = path.parentPath;
      const extractedClassAttributes = new Set();
      rewriteAndCollectArguments(
        [getImportName(path.node.name, path.scope)],
        statementPath.get('arguments'),
        extractedClassAttributes,
      );
      statementPath.replaceWith(convertToExpression(extractedClassAttributes));
    });

  if (isProduction) {
    writeFileSync(cssPath, injectProduction(classCollection, classes.defaults, config));
    state.file.ast.program.body.unshift(t.importDeclaration([], t.stringLiteral('classy-ui/styles.css')));
  } else {
    const localAddClassUid = state.file.scope.generateUidIdentifier('addClasses');

    const runtimeCall = t.expressionStatement(
      t.callExpression(localAddClassUid, [
        t.arrayExpression(
          injectDevelopment(classCollection, classes.defaults, config).map(value => t.stringLiteral(value)),
        ),
      ]),
    );

    state.file.ast.program.body.push(runtimeCall);
    state.file.ast.program.body.unshift(
      t.importDeclaration(
        [t.importSpecifier(localAddClassUid, t.identifier('addClasses'))],
        t.stringLiteral('classy-ui/runtime'),
      ),
    );
  }
}
