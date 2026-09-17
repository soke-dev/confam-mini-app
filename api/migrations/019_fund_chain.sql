-- Which chain a job's money is actually on.
--
-- Until now there was one escrow and no question to answer: every job was on
-- Base, so every relay could assume it. The mini app funds on Polygon, and
-- without this the assumption silently becomes a lie — a job funded on Polygon
-- would be claimed, released, disputed and refunded against the Base contract,
-- where it does not exist. Every one of those reverts, after the money is
-- already locked, and the verifier who walked somewhere cannot be paid.
--
-- Recorded at funding time, because that is the moment it stops being a
-- preference and becomes a fact about where somebody's money is.
--
-- 'base' by default, which is correct for every row that already exists: they
-- were all funded there, and nothing else was possible.

ALTER TABLE questions
  ADD COLUMN fund_chain TEXT NOT NULL DEFAULT 'base';

ALTER TABLE questions ADD CONSTRAINT questions_fund_chain_known
  CHECK (fund_chain IN ('base', 'polygon'));

COMMENT ON COLUMN questions.fund_chain IS
  'Where this job lives on chain. Decides which escrow every later relay talks to.';
