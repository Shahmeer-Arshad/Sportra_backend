-- Court details: indoor/outdoor and a list of image URLs. Existing courts become OUTDOOR until the
-- owner edits them (new courts must say which).
ALTER TABLE "courts" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'OUTDOOR';
ALTER TABLE "courts" ADD CONSTRAINT courts_environment_check CHECK (environment IN ('INDOOR','OUTDOOR'));
ALTER TABLE "courts" ADD COLUMN "images" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "courts" ADD CONSTRAINT courts_images_max CHECK (cardinality(images) <= 10);
