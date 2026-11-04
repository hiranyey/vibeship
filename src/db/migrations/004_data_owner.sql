-- Image projects: who owns `data/`, as "<uid>:<gid>". NULL leaves the folder
-- as Vibeship creates it (owned by root), which is the behaviour before this
-- column existed.
ALTER TABLE image_sources ADD COLUMN data_owner TEXT;
