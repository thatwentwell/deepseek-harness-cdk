#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CONFIG_FILE, DeployConfig, LlmProvider, loadDeployConfig, parseDeployConfig } from '../lib/deploy-config';
import { DeepseekHarnessStack } from '../lib/deepseek-harness-stack';

const app = new cdk.App();

// deploy.config.json is the source of truth (created by `npm run deploy` or
// copied from deploy.config.json.example); `-c key=value` still overrides it.
const saved = loadDeployConfig();
if (!saved) {
  console.error(
    `No existe ${CONFIG_FILE}.\n` +
      'Ejecutá "npm run deploy" para crearlo con el menú, o copiá deploy.config.json.example y editalo.',
  );
  process.exit(1);
}

const ctx = (key: string): string | undefined => app.node.tryGetContext(key);
const str = (key: keyof DeployConfig) => (ctx(key) ?? saved[key]) as string | undefined;
const num = (key: keyof DeployConfig) => Number(ctx(key) ?? saved[key]);
const bool = (key: keyof DeployConfig) => String(ctx(key) ?? saved[key]) === 'true';

new DeepseekHarnessStack(app, str('stackName')!, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: str('region') },
  llmProvider: str('llmProvider') as LlmProvider,
  bedrockModel: str('bedrockModel')!,
  bedrockInferenceProfile: bool('bedrockInferenceProfile'),
  instanceType: str('instanceType')!,
  dshVersion: str('dshVersion')!,
  nodeMajor: num('nodeMajor'),
  webPort: num('webPort'),
  volumeSizeGiB: num('volumeSizeGiB'),
  // `-c network='{"mode":"new","privateSubnet":true}'` overrides the whole object.
  network: ctx('network') ? parseDeployConfig({ ...saved, network: JSON.parse(ctx('network')!) }, '-c network').network : saved.network,
  existingSecretArn: str('existingSecretArn') || undefined,
  blockImdsForAgent: bool('blockImdsForAgent'),
});
