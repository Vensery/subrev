import ts from 'typescript'

/**
 * Symbol-level view of a JS/TS source file, used for two things:
 *  - grouping diff hunks by the declaration they touch (groups.ts), so layer-2 review and the
 *    revert experiment work on "the change to parseDuration()" rather than on raw hunks;
 *  - an AST replacement for layer 1's keyword regexes, which fire on the word "function" in a
 *    comment or string and cannot tell an existing branch from a new one.
 * Other languages fall back to git's hunk context and the original regexes.
 */

export type SymbolKind = 'function' | 'class' | 'method' | 'variable' | 'type' | 'imports' | 'statement' | 'export'

export interface SourceSymbol {
  name: string
  kind: SymbolKind
  startLine: number
  endLine: number
  /** if / switch / ?: / catch nodes inside this symbol. */
  branches: number
}

const JS_LIKE = /\.(?:[cm]?[jt]sx?)$/i

export function isJsLike(filePath: string): boolean {
  return JS_LIKE.test(filePath) && !filePath.endsWith('.d.ts')
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX
  if (/\.[cm]?ts$/i.test(fileName)) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

function countBranches(node: ts.Node): number {
  let count = 0
  const visit = (n: ts.Node): void => {
    if (
      ts.isIfStatement(n) ||
      ts.isSwitchStatement(n) ||
      ts.isConditionalExpression(n) ||
      ts.isCatchClause(n)
    ) {
      count += 1
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return count
}

function isFunctionLike(init: ts.Expression | undefined): boolean {
  if (!init) return false
  let e: ts.Expression = init
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) e = e.expression
  return ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e)
}

export function collectSymbols(source: string, fileName: string): SourceSymbol[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName))
  const line = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1
  const symbols: SourceSymbol[] = []
  const push = (name: string, kind: SymbolKind, node: ts.Node): void => {
    symbols.push({
      name,
      kind,
      startLine: line(node.getStart(sf, true)),
      endLine: line(node.getEnd()),
      branches: countBranches(node),
    })
  }

  let importsStart = -1
  let importsEnd = -1
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      if (importsStart === -1) importsStart = line(stmt.getStart(sf, true))
      importsEnd = line(stmt.getEnd())
      continue
    }
    if (ts.isFunctionDeclaration(stmt)) {
      push(stmt.name?.text ?? 'default', 'function', stmt)
    } else if (ts.isClassDeclaration(stmt)) {
      const className = stmt.name?.text ?? 'default'
      push(className, 'class', stmt)
      for (const member of stmt.members) {
        const memberName = member.name && ts.isIdentifier(member.name) ? member.name.text : member.name?.getText(sf)
        const kind: SymbolKind = ts.isPropertyDeclaration(member) && !isFunctionLike(member.initializer) ? 'variable' : 'method'
        push(`${className}.${memberName ?? 'constructor'}`, kind, member)
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        push(decl.name.getText(sf), isFunctionLike(decl.initializer) ? 'function' : 'variable', decl.getStart(sf) === stmt.declarationList.declarations[0].getStart(sf) ? stmt : decl)
      }
    } else if (
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt) ||
      ts.isModuleDeclaration(stmt)
    ) {
      push(stmt.name.getText(sf), 'type', stmt)
    } else if (ts.isExportAssignment(stmt)) {
      push('export default', 'export', stmt)
    } else if (ts.isExportDeclaration(stmt)) {
      push('(exports)', 'export', stmt)
    } else {
      push('(top-level)', 'statement', stmt)
    }
  }
  if (importsStart !== -1) {
    symbols.push({ name: '(imports)', kind: 'imports', startLine: importsStart, endLine: importsEnd, branches: 0 })
  }
  return symbols
}

/** Innermost symbol containing the line (methods win over their class). */
export function symbolAt(symbols: SourceSymbol[], line: number): SourceSymbol | null {
  let best: SourceSymbol | null = null
  for (const s of symbols) {
    if (line < s.startLine || line > s.endLine) continue
    if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s
  }
  return best
}

const NAMED_KINDS: SymbolKind[] = ['function', 'class', 'method', 'variable', 'type']
const CALLABLE_KINDS: SymbolKind[] = ['function', 'class', 'method']

export interface AstSignals {
  /** Callable declarations (functions, classes, methods) that exist after but not before. */
  newCallables: string[]
  /** Other named declarations (constants, types) that are new. */
  newDeclarations: string[]
  /** Symbols whose branch count went up (new symbols with branches included). */
  branchIncreases: string[]
}

export function compareSymbols(before: SourceSymbol[], after: SourceSymbol[]): AstSignals {
  const beforeByName = new Map<string, SourceSymbol>()
  for (const s of before) {
    const prev = beforeByName.get(s.name)
    beforeByName.set(s.name, prev ? { ...prev, branches: prev.branches + s.branches } : s)
  }
  const afterByName = new Map<string, SourceSymbol>()
  for (const s of after) {
    const prev = afterByName.get(s.name)
    afterByName.set(s.name, prev ? { ...prev, branches: prev.branches + s.branches } : s)
  }
  const newCallables: string[] = []
  const newDeclarations: string[] = []
  const branchIncreases: string[] = []
  for (const [name, s] of afterByName) {
    const old = beforeByName.get(name)
    if (!old && NAMED_KINDS.includes(s.kind)) {
      ;(CALLABLE_KINDS.includes(s.kind) ? newCallables : newDeclarations).push(name)
    }
    // A class's branch count includes its methods'; report the method, not the class too.
    if (s.kind === 'class') continue
    if (s.branches > (old?.branches ?? 0)) branchIncreases.push(name)
  }
  return { newCallables, newDeclarations, branchIncreases }
}
