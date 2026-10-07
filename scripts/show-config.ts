// Prints the saved deploy configuration: `npm run show-config`.
import { CONFIG_FILE, formatDeployConfig, loadDeployConfig } from '../lib/deploy-config';

try {
  const config = loadDeployConfig();
  if (!config) {
    console.error(`No existe ${CONFIG_FILE}. Ejecutá "npm run deploy" primero.`);
    process.exit(1);
  }
  console.log(formatDeployConfig(config));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
