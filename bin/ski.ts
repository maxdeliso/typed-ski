#!/usr/bin/env node

import * as terminalKit from 'terminal-kit'
import { hrtime } from 'process'
import { create } from 'random-seed'
import { Terminal } from 'terminal-kit'
import { SKIExpression, generate } from '../lib/ski/expression'
import { SKITerminalSymbol } from '../lib/ski/terminal'
import { stepOnceSKI } from '../lib'

function colorizeSymbol (sym: SKITerminalSymbol): string {
  switch (sym) {
    case SKITerminalSymbol.S:
      return ' ^[red]S^ '
    case SKITerminalSymbol.K:
      return ' ^[green]K^ '
    case SKITerminalSymbol.I:
      return ' ^[blue]I^ '
    default:
      return '?'
  }
}

function colorizeExpression (expr: SKIExpression): string {
  switch (expr.kind) {
    case 'terminal':
      return colorizeSymbol(expr.sym)
    case 'non-terminal': {
      return [
        '(',
        colorizeExpression(expr.lft),
        colorizeExpression(expr.rgt),
        ')'
      ].join('')
    }
  }
}

function formatted (expr: SKIExpression): string {
  return '> ' + colorizeExpression(expr) + '\n'
}

function runTUI (): number {
  const term : Terminal = terminalKit.terminal
  const seed = hrtime.bigint()
  const randomSeed = create(seed.toString())
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
        const stepResult = stepOnceSKI(expression)
        expression = stepResult.expr
        term(formatted(expression))
        break
      }
      case 'm': {
        let loop = true
        let iterations = 0

        while (loop && iterations < MAX_ITER) {
          const stepResult = stepOnceSKI(expression)
          expression = stepResult.expr
          if (stepResult.altered) {
            term(formatted(expression))
          }
          loop = stepResult.altered
          iterations = iterations + 1
        }

        if (iterations === MAX_ITER) {
          term.red(`stopped evaluating after ${iterations.toString()} iterations. \n`)
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
