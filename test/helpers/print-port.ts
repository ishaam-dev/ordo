/**
 * Helper process for test/config.test.ts: `src/config.ts` computes PORT once, at import,
 * so the only way to characterise the parser is to import it in a child process with a
 * given PORT value. Prints the resolved port and nothing else.
 */
process.env.DOTENV_CONFIG_PATH = `${process.cwd()}/test/helpers/absent.env`;
process.env.DOTENV_CONFIG_QUIET = 'true';
const { PORT } = await import('../../src/config.js');
process.stdout.write(String(PORT));
