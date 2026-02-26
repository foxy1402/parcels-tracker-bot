export type TrackingCheckpoint = {
  time?: string;
  location?: string;
  description?: string;
};

export type TrackingSnapshot = {
  trackingNumber: string;
  carrierCode?: string;
  status: string;
  terminal: boolean;
  lastCheckpoint?: TrackingCheckpoint;
};

export type WatchRow = {
  userId: number;
  trackingNumber: string;
  carrierCode?: string;
  label?: string;
  lastStatusHash?: string;
};
