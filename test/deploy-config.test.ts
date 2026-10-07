import * as fs from 'fs';
import * as path from 'path';
import { EXAMPLE_FILE, loadDeployConfig, parseDeployConfig } from '../lib/deploy-config';

test('the example file is a valid configuration', () => {
  const config = loadDeployConfig(EXAMPLE_FILE)!;
  expect(config.region).toBe('us-east-1');
  expect(config.vpcId).toBeUndefined();
});

test('reports every missing or mistyped field at once', () => {
  expect(() => parseDeployConfig({ region: 'us-east-1', webPort: '3080', extra: 1 }, 'x.json')).toThrow(
    /falta "stackName"[\s\S]*"webPort" debe ser number[\s\S]*campo desconocido "extra"/,
  );
});

test('a missing file loads as undefined', () => {
  expect(loadDeployConfig(path.join(__dirname, 'does-not-exist.json'))).toBeUndefined();
});

test('the real config file is not committed by default', () => {
  expect(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8')).toMatch(/^deploy\.config\.json$/m);
});
