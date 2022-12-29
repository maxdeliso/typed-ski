#!/usr/bin/env node

import * as terminalKit from 'terminal-kit'
import { hrtime } from 'process'
import { create } from 'random-seed'
import { Terminal } from 'terminal-kit'
import { Expression, generate } from '../lib/expression'
import { TerminalSymbol } from '../lib/terminal'
import { stepOnce } from '../lib'

function colorizeSymbol (sym: TerminalSymbol): string {
  switch (sym) {
    case TerminalSymbol.S:
      return ' ^[red]S^ '
    case TerminalSymbol.K:
      return ' ^[green]K^ '
    case TerminalSymbol.I:
      return ' ^[blue]I^ '
    default:
      return '?'
  }
}

function colorizeExpression (expr: Expression): string {
  switch (expr.kind) {
    case 'terminal':
      return colorizeSymbol(expr.sym)
    case 'non-terminal': {
      return [
        '(',
        `${colorizeExpression(expr.lft)}`,
        `${colorizeExpression(expr.rgt)}`,
        ')'
      ].join('')
    }
  }
}

function formatted (expr: Expression): string {
  return '> ' + colorizeExpression(expr) + '\n'
}

function runTUI (): number {
  const term : Terminal = terminalKit.terminal
  const seed = hrtime.bigint()
  const randomSeed = create(`${seed}`)
  const N = 32
  const MAX_ITER = 100

  let expression = generate(randomSeed, N)

  term.cyan('Control C or q or Q exits. ' +
  's steps once. ' +
  'm steps many. ' +
  'g regenerates a new expression. \n')

  term.grabInput({})
  term.on('key', (keyName: string) => {
    switch (keyName) {
      case 'CTRL_C':
      case 'q':
      case 'Q':
        term.grabInput(false)
        break
      case 's': {
        const stepResult = stepOnce(expression)
        expression = stepResult.expr
        term(formatted(expression))
        break
      }
      case 'm': {
        let loop = true
        let iterations = 0

        while (loop && iterations < MAX_ITER) {
          const stepResult = stepOnce(expression)
          expression = stepResult.expr
          if (stepResult.altered) {
            term(formatted(expression))
          }
          loop = stepResult.altered
          iterations = iterations + 1
        }

        if (iterations === MAX_ITER) {
          term.red(`stopped evaluating after ${iterations} iterations. \n`)
        }

        break
      }
      case 'g': {
        expression = generate(randomSeed, N)
        term(formatted(expression))
        break
      }
      default:
        term.red('unrecognized command key: ' + keyName + '\n')
    }
  })

  return 0
}

process.exitCode = runTUI()
