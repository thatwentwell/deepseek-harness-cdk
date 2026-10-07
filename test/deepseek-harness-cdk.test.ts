import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DeepseekHarnessStack } from '../lib/deepseek-harness-stack';

const baseProps = {
  instanceType: 't4g.large',
  dshVersion: '0.2.0-rc.2',
  nodeMajor: 22,
  webPort: 3080,
  volumeSizeGiB: 50,
  privateSubnet: false,
  blockImdsForAgent: true,
};

const synth = (overrides = {}) =>
  Template.fromStack(new DeepseekHarnessStack(new cdk.App(), 'Test', { ...baseProps, ...overrides }));

test('security group has no ingress rules', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'DeepSeek Harness host - egress only',
    SecurityGroupIngress: Match.absent(),
  });
});

test('instance requires IMDSv2 and has an encrypted gp3 root volume', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
  });
  template.hasResourceProperties('AWS::EC2::Instance', {
    BlockDeviceMappings: [{ Ebs: { Encrypted: true, VolumeType: 'gp3', VolumeSize: 50 } }],
  });
});

test('public mode creates no NAT gateway, private mode creates one', () => {
  synth().resourceCountIs('AWS::EC2::NatGateway', 0);
  synth({ privateSubnet: true }).resourceCountIs('AWS::EC2::NatGateway', 1);
});

test('creates the API key secret unless one is supplied', () => {
  synth().resourceCountIs('AWS::SecretsManager::Secret', 1);
  synth({
    existingSecretArn: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:dsh-AbCdEf',
  }).resourceCountIs('AWS::SecretsManager::Secret', 0);
});

test('resources carry the cost allocation tags and the disk inherits them', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::Instance', {
    PropagateTagsToVolumeOnCreation: true,
    Tags: Match.arrayWith([
      { Key: 'app', Value: 'deepseek-harness' },
      { Key: 'stack', Value: 'Test' },
    ]),
  });
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Tags: Match.arrayWith([{ Key: 'stack', Value: 'Test' }]),
  });
});
