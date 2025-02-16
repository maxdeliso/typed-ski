import { hrtime } from 'process';
import rsexport from 'random-seed';
import tkexport from 'terminal-kit';

const { create } = rsexport;
const { terminal } = tkexport;

import {
  // SKI evaluator
  stepOnce,
  // SKI expressions
  prettyPrintSKI,
  type SKIExpression,
  // Parsers
  parseSKI,
  parseLambda,
  parseSystemF,
  parseTypedLambda,
  // Lambda terms
  prettyPrintUntypedLambda,
  type UntypedLambda,
  // System F
  prettyPrintSystemF,
  type SystemFTerm,
  // Typed Lambda
  eraseTypedLambda,
  prettyPrintTypedLambda,
  type TypedLambda,
  typecheckTyped,
  // System F types
  eraseSystemF,
  prettyPrintSystemFType,
  typecheckSystemF,
  // Conversion
  convertLambda,
  // Types
  prettyPrintTy,
  inferType,
  reduce
} from '../lib/index.js';
import { randExpression } from '../lib/ski/generator.js';

enum Mode {
  SKI = 'SKI',
  Lambda = 'Lambda',
  TypedLambda = 'TypedLambda',
  SystemF = 'SystemF'
}

const N = 8;
let currentMode: Mode = Mode.SKI;
let currentSKI: SKIExpression = randExpression(create(hrtime.bigint().toString()), N);
let currentLambda: UntypedLambda | null = null;
let currentTypedLambda: TypedLambda | null = null;
let currentSystemF: SystemFTerm | null = null;
let commandHistory: string[] = [];
let historyIndex: number = -1;
let currentInput: string = '';

function printGreen(msg: string): void {
  terminal('\n');
  terminal.green(msg + '\n');
}
function printCyan(msg: string): void {
  terminal('\n');
  terminal.cyan(msg + '\n');
}
function printYellow(msg: string): void {
  terminal('\n');
  terminal.yellow(msg + '\n');
}
function printRed(msg: string): void {
  terminal('\n');
  terminal.red(msg + '\n');
}

try {
  const lambdaResult = parseLambda('λx.x');
  currentLambda = lambdaResult[1];
  const typedLambdaResult = parseTypedLambda('λx:X.x');
  currentTypedLambda = typedLambdaResult[1];
  const sysFResult = parseSystemF('ΛX.λx:X.x');
  currentSystemF = sysFResult[1];
} catch (e) {
  printRed('error parsing default terms: ' + String(e));
}

function ensureSKIMode(): boolean {
  if (currentMode === Mode.SKI) {
    return true;
  }
  try {
    if (currentMode === Mode.Lambda && currentLambda !== null) {
      currentSKI = convertLambda(currentLambda);
    } else if (currentMode === Mode.TypedLambda && currentTypedLambda !== null) {
      const erasedLambda = eraseTypedLambda(currentTypedLambda);
      if (erasedLambda === null) {
        throw new Error('failed to erase typed lambda term');
      }
      currentSKI = convertLambda(erasedLambda);
    } else if (currentMode === Mode.SystemF && currentSystemF !== null) {
      const erasedTypedLambda = eraseSystemF(currentSystemF);
      if (!erasedTypedLambda) {
        throw new Error('failed to erase System F term');
      }
      const erasedLambda = eraseTypedLambda(erasedTypedLambda);
      if (erasedLambda === null) {
        throw new Error('failed to erase typed lambda term');
      }
      currentSKI = convertLambda(erasedLambda);
    } else {
      throw new Error('current term is null');
    }
    printCyan('converted term to SKI: ' + prettyPrintSKI(currentSKI));
    currentMode = Mode.SKI;
    return true;
  } catch (e) {
    printRed('conversion to SKI failed: ' + String(e));
    return false;
  }
}

function printCurrentTerm(): void {
  switch (currentMode) {
    case Mode.SKI:
      printGreen('SKI Expression: ' + prettyPrintSKI(currentSKI));
      break;
    case Mode.Lambda:
      if (currentLambda !== null) {
        printGreen('Lambda Term: ' + prettyPrintUntypedLambda(currentLambda));
      }
      break;
    case Mode.TypedLambda:
      if (currentTypedLambda !== null) {
        printGreen('Typed Lambda Term: ' + prettyPrintTypedLambda(currentTypedLambda));
      }
      break;
    case Mode.SystemF:
      if (currentSystemF !== null) {
        printGreen('System F Term: ' + prettyPrintSystemF(currentSystemF));
      }
      break;
  }
}

function skiStepOnce(): void {
  const result = stepOnce(currentSKI);
  if (result.altered) {
    currentSKI = result.expr;
    printGreen('stepped: ' + prettyPrintSKI(currentSKI));
  } else {
    printYellow('no further reduction possible.');
  }
}

function skiStepMany(): void {
  const MAX_ITER = 100;
  const result = reduce(currentSKI, MAX_ITER);
  currentSKI = result;
  printGreen(`stepped many (with max of ${MAX_ITER}): ` + prettyPrintSKI(result));
}

function skiRegenerate(): void {
  const rs = create(hrtime.bigint().toString());
  currentSKI = randExpression(rs, N);
  printGreen('generated new SKI expression: ' + prettyPrintSKI(currentSKI));
}

function setNewTerm(input: string): void {
  try {
    switch (currentMode) {
      case Mode.SKI: {
        const skiTerm = parseSKI(input);
        currentSKI = skiTerm;
        printGreen('set new SKI expression: ' + prettyPrintSKI(currentSKI));
        break;
      }
      case Mode.Lambda: {
        const lambdaResult = parseLambda(input);
        currentLambda = lambdaResult[1];
        printGreen('set new Lambda term: ' + prettyPrintUntypedLambda(currentLambda));
        break;
      }
      case Mode.TypedLambda: {
        const typedResult = parseTypedLambda(input);
        currentTypedLambda = typedResult[1];
        printGreen('set new Typed Lambda term: ' + prettyPrintTypedLambda(currentTypedLambda));
        break;
      }
      case Mode.SystemF: {
        const sysFResult = parseSystemF(input);
        currentSystemF = sysFResult[1];
        printGreen('set new System F term: ' + prettyPrintSystemF(currentSystemF));
        break;
      }
    }
  } catch (e) {
    printRed('error parsing term: ' + e);
  }
}

function getPrompt(): string {
  return `\n[${currentMode}] > `;
}

function processCommand(input: string): void {
  if (input === '') return;

  if (input.startsWith(':')) {
    // Remove the colon prefix and trim whitespace.
    const commandLine = input.slice(1).trim();
    const parts = commandLine.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'mode') {
      if (parts.length < 2) {
        printYellow('usage: :mode [ski|lambda|typed|systemf]');
      } else {
        const newMode = parts[1].toLowerCase();
        switch (newMode) {
          case 'ski':
            currentMode = Mode.SKI;
            printCyan('switched to SKI mode.');
            break;
          case 'lambda':
            currentMode = Mode.Lambda;
            printCyan('switched to Lambda mode.');
            break;
          case 'typed':
            currentMode = Mode.TypedLambda;
            printCyan('switched to Typed Lambda mode.');
            break;
          case 'systemf':
            currentMode = Mode.SystemF;
            printCyan('switched to System F mode.');
            break;
          default:
            printRed('unknown mode: ' + parts[1]);
        }
      }
    } else if (cmd === 'help') {
      printHelp();
    } else if (cmd === 'quit') {
      printGreen('exiting REPL.');
      process.exit(0);
    } else if (cmd === 's' || cmd === 'step') {
      if (currentMode !== Mode.SKI && !ensureSKIMode()) return;
      skiStepOnce();
    } else if (cmd === 'm' || cmd === 'stepmany') {
      if (currentMode !== Mode.SKI && !ensureSKIMode()) return;
      skiStepMany();
    } else if (cmd === 'g' || cmd === 'generate') {
      if (currentMode === Mode.SKI) {
        skiRegenerate();
      } else {
        printYellow('generate command only available in SKI mode.');
      }
    } else if (cmd === 'p' || cmd === 'print') {
      printCurrentTerm();
    } else if (cmd === 'tc' || cmd === 'typecheck') {
      switch (currentMode) {
        case Mode.SKI:
          printYellow('Type checking not available in SKI mode.');
          break;
        case Mode.Lambda:
          printYellow('Type checking not available in Lambda mode. Use TypedLambda or SystemF mode.');
          break;
        case Mode.TypedLambda:
          if (currentTypedLambda !== null) {
            try {
              const typeResult = prettyPrintTy(typecheckTyped(currentTypedLambda));
              printGreen('Type of current Typed Lambda term: ' + typeResult.toString());
            } catch (e) {
              printRed('Typechecking error: ' + String(e));
            }
          } else {
            printRed('No current Typed Lambda term available.');
          }
          break;
        case Mode.SystemF:
          if (currentSystemF !== null) {
            try {
              const typeResult = prettyPrintSystemFType(typecheckSystemF(currentSystemF));
              printGreen('Type of current System F term: ' + typeResult.toString());
            } catch (e) {
              printRed('Typechecking error: ' + String(e));
            }
          } else {
            printRed('No current System F term available.');
          }
          break;
      }
    }
    else if (cmd === 'i' || cmd === 'infer') {
      // This command infers the type for the current untyped Lambda expression.
      if (currentMode !== Mode.Lambda) {
        printYellow('Type inference is only available in Lambda mode.');
      } else if (currentLambda === null) {
        printRed('No current Lambda term available for type inference.');
      } else {
        try {
          const [typed, inferredType] = inferType(currentLambda);
          currentTypedLambda = typed;
          // Switch to TypedLambda mode since we now have a typed term.
          currentMode = Mode.TypedLambda;
          printGreen('Inferred Typed Lambda term: ' + prettyPrintTypedLambda(currentTypedLambda));
          printGreen('Inferred type: ' + prettyPrintTy(inferredType));
        } catch (e) {
          printRed('Type inference error: ' + String(e));
        }
      }
    } else {
      printYellow('unknown command: ' + input);
    }
  } else {
    // Any input that does not start with ':' is interpreted as a new term.
    setNewTerm(input);
  }
}

function printHelp(): void {
  printGreen(`
Available commands:
  :mode [ski|lambda|typed|systemf]  -- switch mode
  :help                             -- display this help message
  :quit                             -- exit the REPL
  :s or :step                       -- step once (converts to SKI if necessary)
  :m or :stepmany                   -- step many (max 100 iterations, in SKI mode)
  :g or :generate                   -- generate a new SKI expression (SKI mode only)
  :p or :print                      -- print the current term
  :tc or :typecheck                 -- typecheck the current term (only available in TypedLambda and SystemF modes)
  :i or :infer                      -- infer the type for the current untyped Lambda term and switch to TypedLambda mode

Any other input is interpreted as a new term for the current mode.
Press CTRL+C or type :quit to exit.`);
}

function repl(): void {
  terminal(getPrompt());

  // Save the current terminal line state
  let currentLine = '';

  terminal.inputField(
    {
      history: commandHistory,
      autoComplete: (input: string) => {
        // could add command autocompletion here
        return [];
      },
      autoCompleteHint: false,
      autoCompleteMenu: false,
    },
    (error, input) => {
      if (error) {
        printRed('error: ' + error);
        process.exit(1);
      }

      const trimmedInput = (input || '').trim();
      if (trimmedInput) {
        // Add non-empty commands to history
        commandHistory.push(trimmedInput);
        // Reset history position
        historyIndex = -1;
      }

      processCommand(trimmedInput);
      repl();
    }
  );

  // Handle up/down keys for history navigation
  terminal.on('key', (name: string, matches: any, data: any) => {
    if (name === 'UP') {
      if (historyIndex === -1) {
        // Save current input before navigating history
        currentInput = currentLine;
      }

      if (historyIndex < commandHistory.length - 1) {
        historyIndex++;
        currentLine = commandHistory[commandHistory.length - 1 - historyIndex];
        terminal.eraseLine();
        terminal(getPrompt() + currentLine);
      }
    }
    else if (name === 'DOWN') {
      if (historyIndex > -1) {
        historyIndex--;
        if (historyIndex === -1) {
          currentLine = currentInput;
        } else {
          currentLine = commandHistory[commandHistory.length - 1 - historyIndex];
        }
        terminal.eraseLine();
        terminal(getPrompt() + currentLine);
      }
    }
  });
}

terminal.grabInput({ mouse: 'button' });
terminal.on('key', (name: string) => {
  if (name === 'CTRL_C') {
    printGreen('exiting REPL.');
    process.exit(0);
  }
});

terminal.clear();
terminal.bold.cyan('\nmodal Term Calculator REPL');
terminal.cyan('\nsupported input modes: SKI, Lambda, TypedLambda, SystemF');
terminal.cyan('\ntype :help for a list of commands.');
repl();
