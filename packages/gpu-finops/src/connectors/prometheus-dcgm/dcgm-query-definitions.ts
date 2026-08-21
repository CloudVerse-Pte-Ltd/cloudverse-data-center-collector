export type DcgmMetricValueKind =
  | 'gpu_utilization_pct'
  | 'memory_copy_utilization_pct'
  | 'framebuffer_used_mib'
  | 'framebuffer_free_mib'
  | 'framebuffer_total_mib'
  | 'framebuffer_used_pct'
  | 'power_usage_watts'
  | 'temperature_celsius'
  | 'sm_clock_mhz'
  | 'memory_clock_mhz'
  | 'xid_errors'
  | 'ecc_errors'
  | 'nvlink_bandwidth';

export interface DcgmQueryDefinition {
  name: string;
  description: string;
  metricName: string;
  promql: string;
  valueKind: DcgmMetricValueKind;
  required: boolean;
}

export function getDefaultDcgmQueryDefinitions(): DcgmQueryDefinition[] {
  return [
    {
      name: 'gpu_utilization',
      description: 'GPU utilization percent.',
      metricName: 'DCGM_FI_DEV_GPU_UTIL',
      promql: 'DCGM_FI_DEV_GPU_UTIL',
      valueKind: 'gpu_utilization_pct',
      required: true,
    },
    {
      name: 'memory_copy_utilization',
      description: 'Memory copy utilization percent.',
      metricName: 'DCGM_FI_DEV_MEM_COPY_UTIL',
      promql: 'DCGM_FI_DEV_MEM_COPY_UTIL',
      valueKind: 'memory_copy_utilization_pct',
      required: false,
    },
    {
      name: 'framebuffer_used',
      description: 'Framebuffer memory used in MiB.',
      metricName: 'DCGM_FI_DEV_FB_USED',
      promql: 'DCGM_FI_DEV_FB_USED',
      valueKind: 'framebuffer_used_mib',
      required: false,
    },
    {
      name: 'framebuffer_free',
      description: 'Framebuffer memory free in MiB.',
      metricName: 'DCGM_FI_DEV_FB_FREE',
      promql: 'DCGM_FI_DEV_FB_FREE',
      valueKind: 'framebuffer_free_mib',
      required: false,
    },
    {
      name: 'framebuffer_total',
      description: 'Framebuffer memory total in MiB where available.',
      metricName: 'DCGM_FI_DEV_FB_TOTAL',
      promql: 'DCGM_FI_DEV_FB_TOTAL',
      valueKind: 'framebuffer_total_mib',
      required: false,
    },
    {
      name: 'framebuffer_used_percent',
      description: 'Framebuffer memory used percent where available.',
      metricName: 'DCGM_FI_DEV_FB_USED_PERCENT',
      promql: 'DCGM_FI_DEV_FB_USED_PERCENT',
      valueKind: 'framebuffer_used_pct',
      required: false,
    },
    {
      name: 'power_usage',
      description: 'GPU power usage in watts.',
      metricName: 'DCGM_FI_DEV_POWER_USAGE',
      promql: 'DCGM_FI_DEV_POWER_USAGE',
      valueKind: 'power_usage_watts',
      required: false,
    },
    {
      name: 'temperature',
      description: 'GPU temperature in Celsius.',
      metricName: 'DCGM_FI_DEV_GPU_TEMP',
      promql: 'DCGM_FI_DEV_GPU_TEMP',
      valueKind: 'temperature_celsius',
      required: false,
    },
    {
      name: 'sm_clock',
      description: 'SM clock in MHz where available.',
      metricName: 'DCGM_FI_DEV_SM_CLOCK',
      promql: 'DCGM_FI_DEV_SM_CLOCK',
      valueKind: 'sm_clock_mhz',
      required: false,
    },
    {
      name: 'memory_clock',
      description: 'Memory clock in MHz where available.',
      metricName: 'DCGM_FI_DEV_MEM_CLOCK',
      promql: 'DCGM_FI_DEV_MEM_CLOCK',
      valueKind: 'memory_clock_mhz',
      required: false,
    },
    {
      name: 'xid_errors',
      description: 'GPU XID errors.',
      metricName: 'DCGM_FI_DEV_XID_ERRORS',
      promql: 'DCGM_FI_DEV_XID_ERRORS',
      valueKind: 'xid_errors',
      required: false,
    },
    {
      name: 'ecc_errors',
      description: 'ECC error signals where available.',
      metricName: 'DCGM_FI_DEV_ECC_DBE_VOL_TOTAL',
      promql: 'DCGM_FI_DEV_ECC_DBE_VOL_TOTAL',
      valueKind: 'ecc_errors',
      required: false,
    },
    {
      name: 'nvlink_bandwidth',
      description: 'NVLink bandwidth where available.',
      metricName: 'DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL',
      promql: 'DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL',
      valueKind: 'nvlink_bandwidth',
      required: false,
    },
  ];
}
