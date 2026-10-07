import * as fs from 'fs';
import * as path from 'path';
import { EXAMPLE_FILE, loadDeployConfig, parseDeployConfig } from '../lib/deploy-config';

test('the example file is a valid configuration', () => {
  const config = loadDeployConfig(EXAMPLE_FILE)!;
  expect(config.region).toBe('us-east-1');
  expect(config.network).toEqual({ mode: 'new', privateSubnet: false });
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

test('rejects an unknown provider or Bedrock model', () => {
  const valid = loadDeployConfig(EXAMPLE_FILE)!;
  expect(() => parseDeployConfig({ ...valid, llmProvider: 'openai' }, 'x.json')).toThrow(/"llmProvider" debe ser bedrock o deepseek-api/);
  expect(() => parseDeployConfig({ ...valid, bedrockModel: 'deepseek.r1-v1:0' }, 'x.json')).toThrow(/"bedrockModel" debe ser uno de/);
  // The model is irrelevant when the API is used.
  expect(parseDeployConfig({ ...valid, llmProvider: 'deepseek-api', bedrockModel: 'x' }, 'x.json').llmProvider).toBe('deepseek-api');
});

test('validates the network object for each mode', () => {
  const valid = loadDeployConfig(EXAMPLE_FILE)!;
  const existing = { mode: 'existing', vpcId: 'vpc-0abc', subnetId: 'subnet-0def', availabilityZone: 'us-east-1a', subnetType: 'public' };
  expect(parseDeployConfig({ ...valid, network: existing }, 'x.json').network).toEqual(existing);
  expect(() => parseDeployConfig({ ...valid, network: { mode: 'shared' } }, 'x.json')).toThrow(/"network.mode" debe ser new o existing/);
  expect(() => parseDeployConfig({ ...valid, network: { mode: 'existing', vpcId: 'vpc-0abc' } }, 'x.json')).toThrow(
    /falta "network.subnetId"[\s\S]*falta "network.availabilityZone"/,
  );
  expect(() => parseDeployConfig({ ...valid, network: { ...existing, subnetType: 'isolated' } }, 'x.json')).toThrow(
    /"network.subnetType" debe ser public o private/,
  );
  expect(() => parseDeployConfig({ ...valid, network: { mode: 'new', privateSubnet: false, vpcId: 'vpc-1' } }, 'x.json')).toThrow(
    /campo desconocido "network.vpcId"/,
  );
});
