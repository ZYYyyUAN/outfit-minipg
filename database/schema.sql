-- P2-02: reviewed empty project database only; no seed data.
SELECT VERSION() AS server_version, CURRENT_USER() AS account, @@port AS server_port, @@session.foreign_key_checks AS fk_checks, @@session.sql_mode AS sql_mode;
CREATE DATABASE IF NOT EXISTS wardrobe_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
USE wardrobe_demo;

CREATE TABLE users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nickname VARCHAR(20) NOT NULL,
  avatar_path VARCHAR(255) NULL DEFAULT NULL,
  auth_token_hash CHAR(64) NULL DEFAULT NULL,
  auth_expires_at DATETIME(3) NULL DEFAULT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_auth_token_hash (auth_token_hash),
  CONSTRAINT ck_users_auth_pair CHECK ((auth_token_hash IS NULL AND auth_expires_at IS NULL) OR (auth_token_hash IS NOT NULL AND auth_expires_at IS NOT NULL)) ENFORCED
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;

CREATE TABLE categories (
  id VARCHAR(16) NOT NULL,
  name VARCHAR(20) NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_name (name),
  CONSTRAINT ck_categories_sort CHECK (sort_order BETWEEN 1 AND 7) ENFORCED
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;

CREATE TABLE clothes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  category_id VARCHAR(16) NOT NULL,
  name VARCHAR(40) NOT NULL,
  image_path VARCHAR(255) NOT NULL,
  color VARCHAR(20) NOT NULL,
  season VARCHAR(8) NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  is_archived TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_clothes_user_archived_id (user_id, is_archived, id),
  KEY idx_clothes_category (category_id),
  CONSTRAINT fk_clothes_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_clothes_category FOREIGN KEY (category_id) REFERENCES categories(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_clothes_archived CHECK (is_archived IN (0,1)) ENFORCED,
  CONSTRAINT ck_clothes_season CHECK (season IN (_utf8mb4 0xe698a5,_utf8mb4 0xe5a48f,_utf8mb4 0xe7a78b,_utf8mb4 0xe586ac,_utf8mb4 0xe698a5e5a48f,_utf8mb4 0xe698a5e7a78b,_utf8mb4 0xe7a78be586ac,_utf8mb4 0xe59b9be5ada3)) ENFORCED
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;

CREATE TABLE outfits (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(40) NOT NULL,
  occasion VARCHAR(20) NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  is_archived TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_outfits_user_archived_id (user_id, is_archived, id),
  CONSTRAINT fk_outfits_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_outfits_archived CHECK (is_archived IN (0,1)) ENFORCED
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;

CREATE TABLE outfit_items (
  outfit_id INT UNSIGNED NOT NULL,
  clothing_id INT UNSIGNED NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (outfit_id, clothing_id),
  UNIQUE KEY uq_outfit_items_order (outfit_id, sort_order),
  KEY idx_outfit_items_clothing (clothing_id, outfit_id),
  CONSTRAINT fk_outfit_items_outfit FOREIGN KEY (outfit_id) REFERENCES outfits(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_outfit_items_clothing FOREIGN KEY (clothing_id) REFERENCES clothes(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_outfit_items_sort CHECK (sort_order>=1) ENFORCED
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;

CREATE TABLE diaries (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  wear_date DATE NOT NULL,
  source_outfit_id INT UNSIGNED NULL DEFAULT NULL,
  occasion VARCHAR(20) NOT NULL,
  mood VARCHAR(12) NULL DEFAULT NULL,
  photo_path VARCHAR(255) NULL DEFAULT NULL,
  note VARCHAR(1000) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_diaries_user_date (user_id, wear_date),
  KEY idx_diaries_source_outfit (source_outfit_id),
  CONSTRAINT fk_diaries_user FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_diaries_source FOREIGN KEY (source_outfit_id) REFERENCES outfits(id) ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;

CREATE TABLE diary_items (
  diary_id INT UNSIGNED NOT NULL,
  clothing_id INT UNSIGNED NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (diary_id, clothing_id),
  UNIQUE KEY uq_diary_items_order (diary_id, sort_order),
  KEY idx_diary_items_clothing (clothing_id, diary_id),
  CONSTRAINT fk_diary_items_diary FOREIGN KEY (diary_id) REFERENCES diaries(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT fk_diary_items_clothing FOREIGN KEY (clothing_id) REFERENCES clothes(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT ck_diary_items_sort CHECK (sort_order>=1) ENFORCED
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;
