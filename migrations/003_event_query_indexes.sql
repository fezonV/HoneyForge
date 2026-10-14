CREATE INDEX events_time_idx ON events(occurred_at DESC,id,agent_id);
CREATE INDEX events_source_time_idx ON events(source_ip,occurred_at DESC,id,agent_id) WHERE source_ip IS NOT NULL;
CREATE INDEX events_type_time_idx ON events(event_type,occurred_at DESC,id,agent_id);
