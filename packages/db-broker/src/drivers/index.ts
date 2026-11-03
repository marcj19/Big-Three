import type { ConnectionProfile, Driver } from '../types.js';
import { MysqlDriver } from './mysql.js';
import { OracleDriver } from './oracle.js';
import { PostgresDriver } from './postgres.js';

export interface DriverConfig {
  profile: ConnectionProfile;
  password: string;
}

export type DriverFactory = (config: DriverConfig) => Driver;

export const createDriver: DriverFactory = (config) => {
  switch (config.profile.engine) {
    case 'postgres':
      return new PostgresDriver(config);
    case 'mysql':
      return new MysqlDriver(config);
    case 'oracle':
      return new OracleDriver(config);
  }
};
