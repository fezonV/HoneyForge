package agent

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"honeyforge/internal/contracts"
)

// claimCommand persists intent before touching the decoy. Completed results
// survive lost center responses and process restarts. An interrupted intent is
// reported as uncertain/failed rather than replaying a possibly completed action.
func (q *EventQueue) claimCommand(ctx context.Context, agentID string, command contracts.Command, expires time.Time) (bool, error) {
	command.Status, command.Error = "", ""
	body, err := json.Marshal(command)
	if err != nil {
		return false, err
	}
	sum := sha256.Sum256(body)
	hash := hex.EncodeToString(sum[:])
	q.mu.Lock()
	defer q.mu.Unlock()
	var previous string
	err = q.db.QueryRowContext(ctx, `SELECT body_hash FROM command_results WHERE agent_id=? AND command_id=?`, agentID, command.ID).Scan(&previous)
	if err == nil {
		if previous != hash {
			return false, errors.New("command ID reused with different content")
		}
		return false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if _, err = q.db.ExecContext(ctx, `DELETE FROM command_results WHERE reported=1 AND expires_at<?`, time.Now().UTC().Add(-24*time.Hour).Format(time.RFC3339Nano)); err != nil {
		return false, err
	}
	var count int
	if err = q.db.QueryRowContext(ctx, `SELECT count(*) FROM command_results`).Scan(&count); err != nil {
		return false, err
	}
	if count >= 10000 {
		return false, errors.New("command journal is full")
	}
	_, err = q.db.ExecContext(ctx, `INSERT INTO command_results(agent_id,command_id,body_hash,expires_at) VALUES(?,?,?,?)`, agentID, command.ID, hash, expires.UTC().Format(time.RFC3339Nano))
	return err == nil, err
}

func (q *EventQueue) finishCommand(ctx context.Context, agentID, id string, result CommandResult) error {
	_, err := q.db.ExecContext(ctx, `UPDATE command_results SET status=?,error=? WHERE agent_id=? AND command_id=?`, result.Status, result.Error, agentID, id)
	return err
}

func (q *EventQueue) reportResults(ctx context.Context, client *Client, state *State) error {
	// Called under commandMu, so no live execution can be mistaken for a crash.
	if _, err := q.db.ExecContext(ctx, `UPDATE command_results SET status='failed',error='command outcome unknown after interruption; inspect decoy before retrying' WHERE agent_id=? AND status=''`, state.AgentID); err != nil {
		return err
	}
	rows, err := q.db.QueryContext(ctx, `SELECT command_id,status,error FROM command_results WHERE agent_id=? AND reported=0 ORDER BY expires_at,command_id LIMIT 20`, state.AgentID)
	if err != nil {
		return err
	}
	type pendingResult struct {
		id     string
		result CommandResult
	}
	var pending []pendingResult
	for rows.Next() {
		var p pendingResult
		if err = rows.Scan(&p.id, &p.result.Status, &p.result.Error); err != nil {
			break
		}
		pending = append(pending, p)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return err
	}
	for _, p := range pending {
		err = client.ReportCommand(ctx, state, p.id, p.result.Status, p.result.Error)
		var statusErr *HTTPStatusError
		if err != nil && !(errors.As(err, &statusErr) && statusErr.StatusCode == 409 && statusErr.Message == "command_expired") {
			return fmt.Errorf("report command %s: %w", p.id, err)
		}
		if _, err = q.db.ExecContext(ctx, `UPDATE command_results SET reported=1 WHERE agent_id=? AND command_id=?`, state.AgentID, p.id); err != nil {
			return err
		}
	}
	return nil
}
