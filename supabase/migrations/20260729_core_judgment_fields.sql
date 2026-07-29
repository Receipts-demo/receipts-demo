-- Shipped Card Rebuild: five-question human judgment template
-- (project_id: e6dde4b8-77a0-42b9-a4a1-95a3847eccfc)
-- key_wins and one_line_learning are kept, not dropped, for backward
-- compatibility with already-shipped cards that haven't been regenerated.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS core_problem text,
  ADD COLUMN IF NOT EXISTS core_evidence text,
  ADD COLUMN IF NOT EXISTS core_decision text,
  ADD COLUMN IF NOT EXISTS rejected_alternatives text,
  ADD COLUMN IF NOT EXISTS outcome_or_learning text;
