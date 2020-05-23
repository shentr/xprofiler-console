'use strict';

const Controller = require('egg').Controller;

class ProcessController extends Controller {
  async getNodeProcesses() {
    const { ctx } = this;
    const { appId, agentId } = ctx.query;

    const processes = await ctx.handleXtransitResponse('getAgentNodeProcesses', appId, agentId);
    if (!processes) {
      return;
    }

    const list = processes.split('\n')
      .map(process => {
        const [pid, command] = process.split('\u0000');
        if (pid && command) {
          return ({ pid, command });
        }
      })
      .filter(process => process);

    ctx.body = { ok: true, data: { list } };
  }

  async getXprofilerProcesses() {
    const { ctx, ctx: { service: { overview } } } = this;
    const { appId, agentId } = ctx.query;

    const tasks = [];
    tasks.push(overview.getLatestProcessData(appId, agentId));
    tasks.push(ctx.handleXtransitResponse('getAgentNodeProcesses', appId, agentId));
    let [logs, processes] = await Promise.all(tasks);
    processes = processes.split('\n')
      .map(process => {
        const [pid, command] = process.split('\u0000');
        if (pid && command) {
          return ({ pid, command });
        }
      })
      .filter(process => process);


    const data = { list: [], nodes: [] };

    if (!logs) {
      data.nodes = processes;
    } else {
      for (const [pid, log] of Object.entries(logs)) {
        const process = processes.filter(process => Number(process.pid) === Number(pid))[0];
        if (!process) {
          continue;
        }
        const {
          uptime,
          cpu_60,
          heap_used_percent,
          gc_time_during_last_record,
          rss,
          active_handles,
          active_timer_handles,
          active_tcp_handles,
          active_udp_handles,
        } = log;

        const proc = {
          pid,
          cmd: process.command,
          startTime: Date.now() - uptime * 1000,
          cpuUsage: cpu_60.toFixed(2),
          heapUsage: heap_used_percent.toFixed(2),
          gcUsage: (gc_time_during_last_record / (60 * 1000) * 100).toFixed(2),
          rss,
          uvHandles: active_handles,
          timers: active_timer_handles,
          tcpHandles: active_tcp_handles,
          udpHandles: active_udp_handles,
        };

        data.list.push(proc);
      }
    }

    if (!data.list.length) {
      data.nodes = processes;
    }

    ctx.body = { ok: true, data };
  }

  async checkXprofilerStatus() {
    const { ctx } = this;
    const { appId, agentId, pid } = ctx.query;

    const stdout = await ctx.handleXtransitResponse('checkProcessStatus', appId, agentId, pid);
    if (stdout === false) {
      return;
    }

    const data = JSON.parse(stdout);

    ctx.body = { ok: true, data };
  }

  async getProcessTrend() {
    const { ctx, ctx: { service: { process } } } = this;
    const { appId, agentId, pid, trendType, duration } = ctx.query;

    const period = duration * 60;
    const trends = await process.getDataByPeriodAndPid(appId, agentId, period, pid);
    const data = process.handleTrends(trends, trendType, duration);

    ctx.body = { ok: true, data };
  }

  async takeAction() {
    const { ctx, ctx: { app: { config: { profilingTime } }, service: { mysql } } } = this;
    const { appId, agentId, pid, action } = ctx.request.body;

    let command = '';
    const options = {};
    switch (action) {
      case 'cpuprofile':
        command = 'start_cpu_profiling';
        options.profiling_time = profilingTime[command];
        break;
      case 'heapprofile':
        command = 'start_heap_profiling';
        options.profiling_time = profilingTime[command];
        break;
      case 'gcprofile':
        command = 'start_gc_profiling';
        options.profiling_time = profilingTime[command];
        break;
      case 'heapsnapshot':
        command = 'heapdump';
        break;
      case 'diag':
        command = 'diag_report';
        break;
      default:
        break;
    }

    if (!command) {
      return (ctx.body = { ok: false, message: `不支持的操作: ${action}` });
    }

    const result = await ctx.handleXtransitResponse('takeAction', appId, agentId, pid, command, options);
    if (!result) {
      return;
    }
    const { filepath: file } = JSON.parse(result);
    const { userId } = ctx.user;
    await mysql.addFile(appId, agentId, action, file, userId);

    ctx.body = { ok: true, data: { file } };
  }
}

module.exports = ProcessController;
