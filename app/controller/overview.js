'use strict';

const pMap = require('p-map');
const Controller = require('egg').Controller;

class OverviewController extends Controller {
  async getOverviewMetrics() {
    const { ctx, ctx: { service: { manager, mysql, alarm } } } = this;
    const { appId } = ctx.query;


    const tasks = [];
    tasks.push(manager.getClients(appId));
    tasks.push(mysql.getStrategiesByAppId(appId));
    const [{ clients }, strategies] = await Promise.all(tasks);

    // get instance count
    const instanceCount = Array.isArray(clients) && clients.length;

    // get alarm count
    let alarmCount;
    if (instanceCount) {
      alarmCount = (await pMap(strategies, async ({ id }) => {
        const history = await alarm.getHistoryByPeriod(id, 24 * 60);
        return history.length;
      }, { concurrency: 2 })).reduce((total, count) => (total += count), 0);
    }

    // get risk count
    let riskCount;
    if (instanceCount) {
      if (instanceCount === 0) {
        riskCount = 0;
      } else {
        const { agentId } = clients[0];
        const { files } = await manager.getFiles(appId, agentId, 'package', { fromCache: true });
        if (!Array.isArray(files)) {
          riskCount = '-';
        } else if (files.every(file => !file.risk)) {
          riskCount = '-';
        } else {
          riskCount = files.reduce((total, fileInfo) => {
            const { vulnerabilities: { high, critical } } = fileInfo.risk;
            return (total += (Number(high) + Number(critical)));
          }, 0);
        }
      }
    }

    const data = { instanceCount, alarmCount, riskCount };

    ctx.body = { ok: true, data };
  }

  async getMainMetrics() {
    const { ctx, ctx: { app, service: { manager, overview } } } = this;
    const { appId, type } = ctx.query;

    const { clients } = await manager.getClients(appId);
    if (!Array.isArray(clients)) {
      return (ctx.body = { ok: true, data: { list: [] } });
    }

    let list = await pMap(clients, async ({ agentId }) => {
      const data = { agentId };
      try {
        if (['processCpuUsage', 'processMemoryUsage'].includes(type)) {
          data.log = await overview.getLatestProcessData(appId, agentId);
        }
        if (['systemCpuUsage', 'systemMemoryUsage', 'diskUsage'].includes(type)) {
          data.log = await overview.getLatestSystemData(appId, agentId);
        }
      } catch (err) {
        ctx.logger.error(`getMainMetrics falied: ${err}`);
      }
      return data;
    }, { concurrency: 2 });

    list = list.map(({ agentId, log }) => {
      const data = {
        agentId,
        status: 0,
        title: '-',
        pid: undefined,
      };

      if (log) {
        switch (type) {
          case 'processCpuUsage': {
            const { maxPid, maxData } = overview.comparePidsInAgent(log, 'cpu_60');
            data.status = overview.getStatus(maxData);
            data.title = `${Number(maxData.toFixed(2))}%`;
            data.pid = maxPid;
          }
            break;
          case 'processMemoryUsage': {
            const { maxPid, maxData } = overview.comparePidsInAgent(log, 'heap_used_percent');
            data.status = overview.getStatus(maxData);
            data.title = `${app.formatSize(log[maxPid].heap_used)}`;
            data.pid = maxPid;
          }
            break;
          case 'systemCpuUsage': {
            let { used_cpu } = log;
            used_cpu = used_cpu * 100;
            data.status = overview.getStatus(used_cpu);
            data.title = `${Number(used_cpu.toFixed(2))}%`;
          }
            break;
          case 'systemMemoryUsage': {
            let { used_memory, used_memory_percent } = log;
            used_memory_percent = used_memory_percent * 100;
            data.status = overview.getStatus(used_memory_percent);
            data.title = `${app.formatSize(used_memory)}`;
          }
            break;
          case 'diskUsage': {
            const { max_disk, max_disk_usage } = log;
            data.status = overview.getStatus(max_disk_usage);
            data.title = `${max_disk} : ${max_disk_usage}%`;
          }
            break;
          default:
            break;
        }
      }
      return data;
    });

    ctx.body = { ok: true, data: { list } };
  }
}

module.exports = OverviewController;
