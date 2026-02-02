-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1:3307
-- Generation Time: Sep 21, 2025 at 09:58 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `darixo_solution`
--

-- --------------------------------------------------------

--
-- Table structure for table `admins`
--

CREATE TABLE `admins` (
  `id` int(11) NOT NULL,
  `full_name` varchar(150) NOT NULL,
  `mobile` varchar(20) NOT NULL,
  `email` varchar(150) NOT NULL,
  `password` varchar(255) NOT NULL,
  `panel_client_key` varchar(100) DEFAULT NULL,
  `all_permission` tinyint(1) DEFAULT 0,
  `add_client` tinyint(1) DEFAULT 0,
  `edit_client` tinyint(1) DEFAULT 0,
  `licence_permission` tinyint(1) DEFAULT 0,
  `go_to_dashboard` tinyint(1) DEFAULT 0,
  `trade_history` tinyint(1) DEFAULT 0,
  `full_info_view` tinyint(1) DEFAULT 0,
  `update_client_api_key` tinyint(1) DEFAULT 0,
  `strategy_permission` tinyint(1) DEFAULT 0,
  `group_service_permission` tinyint(1) DEFAULT 0,
  `role` enum('admin','sub-admin') DEFAULT 'sub-admin',
  `status` enum('active','inactive') DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `profile_img` varchar(255) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `admins`
--

INSERT INTO `admins` (`id`, `full_name`, `mobile`, `email`, `password`, `panel_client_key`, `all_permission`, `add_client`, `edit_client`, `licence_permission`, `go_to_dashboard`, `trade_history`, `full_info_view`, `update_client_api_key`, `strategy_permission`, `group_service_permission`, `role`, `status`, `created_at`, `updated_at`, `profile_img`) VALUES
(2, 'Deepak Sharma', '9876543210', 'deepak@example.com', '30596b7a8da12bbcec9fd860c7a652beb1047336f1f787d238605156c0a8d106', 'darixo-key-001', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 'admin', 'active', '2025-08-23 07:05:52', '2025-08-23 08:30:41', NULL),
(3, 'Lalit prajapati', '9876543220', 'lalit@example.com', '$2b$10$1h595QK6wzT8Ncma7bM2gusLSgQoiIWu5ZTiQtX1gNkKnn3afZQR6', 'darixo-key-002', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 'admin', 'active', '2025-08-23 14:09:03', '2025-08-23 14:09:03', NULL),
(4, 'Akash Ji ', '8120652523', 'nom@gmail.com', '$2b$10$EPz9YGy99tmLxhJ9Q4T6xOf6oWm4nDlp1wr5LxEOIYJm6qdcEfNgq', 'darixo-key-003', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'admin', 'active', '2025-08-23 15:28:45', '2025-08-23 15:28:45', NULL),
(5, 'New Admin Name', '9876543211', 'newadmin@example.com', '$2b$10$232w6.Z.FBHMhWu.1WMa5.wUBcnSRDpsbKNBQkuF86IVN9cNVQCP6', 'new_key123', 1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 'sub-admin', 'active', '2025-09-03 17:06:13', '2025-09-03 17:09:26', NULL);

-- --------------------------------------------------------

--
-- Table structure for table `client_save`
--

CREATE TABLE `client_save` (
  `id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `user_name` varchar(100) NOT NULL,
  `email` varchar(150) NOT NULL,
  `created_at` datetime DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `forgot_otp`
--

CREATE TABLE `forgot_otp` (
  `id` bigint(20) UNSIGNED NOT NULL,
  `admin_id` int(11) NOT NULL,
  `otp` varchar(6) NOT NULL,
  `status` smallint(6) DEFAULT 1,
  `expires_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `forgot_otp`
--

INSERT INTO `forgot_otp` (`id`, `admin_id`, `otp`, `status`, `expires_at`, `created_at`, `updated_at`) VALUES
(1, 2, '343685', 0, '2025-08-23 08:47:22', '2025-08-23 08:08:47', '2025-08-23 08:47:22');

-- --------------------------------------------------------

--
-- Table structure for table `inquiry`
--

CREATE TABLE `inquiry` (
  `id` int(11) NOT NULL,
  `full_name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `mobile_number` varchar(20) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `inquiry`
--

INSERT INTO `inquiry` (`id`, `full_name`, `email`, `mobile_number`, `created_at`, `updated_at`) VALUES
(1, 'deepak', 'deepaksharmacs45@gmail.com', '8770918486', '2025-08-24 12:02:19', '2025-08-24 12:02:19');

-- --------------------------------------------------------

--
-- Table structure for table `otps`
--

CREATE TABLE `otps` (
  `id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `otp` varchar(10) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `used` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `otps`
--

INSERT INTO `otps` (`id`, `user_id`, `otp`, `created_at`, `used`) VALUES
(1, 6, '6894', '2025-08-24 09:51:27', 0),
(2, 6, '6894', '2025-08-27 16:47:46', 0);

-- --------------------------------------------------------

--
-- Table structure for table `strategies`
--

CREATE TABLE `strategies` (
  `id` int(11) NOT NULL,
  `strategy_name` varchar(150) NOT NULL,
  `segment` varchar(100) NOT NULL,
  `strategy_description` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `strategies`
--

INSERT INTO `strategies` (`id`, `strategy_name`, `segment`, `strategy_description`, `created_at`, `updated_at`) VALUES
(1, 'Scalping Strategy', 'NIFTY', 'This is a short-term intraday scalping strategy.', '2025-08-26 16:57:09', '2025-08-26 16:57:09'),
(2, 'Scalping Strategy', 'Alfa', 'This is a short-term intraday scalping strategy.', '2025-08-26 17:11:02', '2025-08-26 17:11:02');

-- --------------------------------------------------------

--
-- Table structure for table `trading`
--

CREATE TABLE `trading` (
  `id` int(11) NOT NULL,
  `trade_type` varchar(50) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `trading`
--

INSERT INTO `trading` (`id`, `trade_type`) VALUES
(1, 'demo'),
(2, 'live'),
(3, '2 days demo');

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `id` int(11) NOT NULL,
  `user_name` varchar(100) NOT NULL,
  `email` varchar(150) NOT NULL,
  `full_name` varchar(150) DEFAULT NULL,
  `client_key` varchar(100) DEFAULT NULL,
  `phone_number` varchar(20) DEFAULT NULL,
  `licence` enum('Live','Demo') NOT NULL DEFAULT 'Live',
  `to_month` varchar(50) DEFAULT NULL,
  `sub_admin` varchar(150) DEFAULT NULL,
  `service_to_month` varchar(50) DEFAULT NULL,
  `group_service` varchar(150) DEFAULT NULL,
  `broker` varchar(100) DEFAULT NULL,
  `status` enum('active','inactive') DEFAULT 'active',
  `trading_status` enum('enabled','disabled') DEFAULT 'enabled',
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `password` varchar(255) DEFAULT NULL,
  `is_login` tinyint(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`id`, `user_name`, `email`, `full_name`, `client_key`, `phone_number`, `licence`, `to_month`, `sub_admin`, `service_to_month`, `group_service`, `broker`, `status`, `trading_status`, `start_date`, `end_date`, `created_at`, `updated_at`, `password`, `is_login`) VALUES
(6, 'deepak', 'deepaksharmacs45@gmail.com', 'deepak Sharma Doe', '6da4b1de-09e0-4578-922b-a5c43aba953e', '8770916894', 'Live', NULL, NULL, NULL, NULL, 'grow', '', '', '2025-08-24', '2025-08-31', '2025-08-24 08:49:07', '2025-08-27 16:47:46', '$2b$10$5PKVzmi.8kmU91pMv/B8F.HOQCqu5VaeqrW1VfLd6CrQU/BW4yTye', 1),
(7, 'john_doe', 'johndoe@example.com', 'John Doe', 'd4fe9599-dba7-480e-a823-811d6f021ddb', '9876543210', 'Live', '2026-09', 'subadmin01', '2026-09', 'PremiumGroup', 'Zerodha', 'active', 'enabled', '2025-09-01', '2026-09-01', '2025-08-26 16:14:16', '2025-08-26 16:14:16', '$2b$10$1dSdOAUVi6ysyIiVf1czBOyHytii4fIs.JuQ2zYIjdlu7XcjyT5DS', 0),
(8, 'john_doe', 'johndoe12@example.com', 'John Doe', '7abdbc1a-1fba-48c8-9b61-1defadce5992', '9886543210', 'Live', '2026-09', 'subadmin01', '2026-09', 'PremiumGroup', 'Zerodha', 'active', 'enabled', '2025-09-01', '2026-09-01', '2025-09-03 16:58:05', '2025-09-03 16:59:47', '$2b$10$7m/bEqkTlpmiBG8Pjq3BbOBoy6MbBwhZ5uA2jX9YfTukDCjqZEVka', 0);

--
-- Indexes for dumped tables
--

--
-- Indexes for table `admins`
--
ALTER TABLE `admins`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`),
  ADD UNIQUE KEY `panel_client_key` (`panel_client_key`);

--
-- Indexes for table `client_save`
--
ALTER TABLE `client_save`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`);

--
-- Indexes for table `forgot_otp`
--
ALTER TABLE `forgot_otp`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_admin` (`admin_id`);

--
-- Indexes for table `inquiry`
--
ALTER TABLE `inquiry`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `otps`
--
ALTER TABLE `otps`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_user` (`user_id`);

--
-- Indexes for table `strategies`
--
ALTER TABLE `strategies`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `trading`
--
ALTER TABLE `trading`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `email` (`email`),
  ADD UNIQUE KEY `client_key` (`client_key`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `admins`
--
ALTER TABLE `admins`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- AUTO_INCREMENT for table `client_save`
--
ALTER TABLE `client_save`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `forgot_otp`
--
ALTER TABLE `forgot_otp`
  MODIFY `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `inquiry`
--
ALTER TABLE `inquiry`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

--
-- AUTO_INCREMENT for table `otps`
--
ALTER TABLE `otps`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `strategies`
--
ALTER TABLE `strategies`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=3;

--
-- AUTO_INCREMENT for table `trading`
--
ALTER TABLE `trading`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `forgot_otp`
--
ALTER TABLE `forgot_otp`
  ADD CONSTRAINT `fk_admin` FOREIGN KEY (`admin_id`) REFERENCES `admins` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `otps`
--
ALTER TABLE `otps`
  ADD CONSTRAINT `fk_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
