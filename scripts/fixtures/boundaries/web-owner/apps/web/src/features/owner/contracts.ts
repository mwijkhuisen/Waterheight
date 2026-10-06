// Fixture (P10a): the owner chunk may import the owner schemas, never the owner API contracts.
import { OwnerStaticSources } from '@rws/contracts/static-owner';
import { OwnerMetaAnswer } from '@rws/contracts/api-owner';
import { QC } from '@rws/core/qc';

export const all = [OwnerStaticSources, OwnerMetaAnswer, QC];
